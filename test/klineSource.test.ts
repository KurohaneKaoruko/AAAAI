/**
 * K 线数据源回归：测试网只能影响下单/账户，公开行情必须走主网真实数据。
 *
 * 背景：Binance 测试网自带的 K 线经常与主网严重偏离（长影线、不同价格），
 * 如果 fetchKlines 跟着 testnet 走，界面上就会把测试网行情当成实盘 K 线。
 * 这里用 fetch 桩锁住 URL，不依赖外网。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BinanceAdapter } from "../src/exchanges/binance.js";
import { GateAdapter } from "../src/exchanges/gate.js";
import { GateFuturesAdapter } from "../src/exchanges/gateFutures.js";

type FetchFn = typeof globalThis.fetch;

function stubFetch(handler: (url: string) => unknown): { urls: string[]; restore: () => void } {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    return new Response(JSON.stringify(handler(url)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as FetchFn;
  return {
    urls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("Binance：测试网连接拉 K 线仍走主网 data-api；下单才走测试网", async () => {
  const stub = stubFetch((url) => {
    if (url.includes("/klines")) {
      return [[1793491200000, "100", "110", "90", "105", "12", 0, "0", 1, "0", "0", "0"]];
    }
    if (url.includes("/order")) {
      return { orderId: 1, executedQty: "0.1", cummulativeQuoteQty: "105" };
    }
    return {};
  });
  try {
    const a = new BinanceAdapter();
    a.init({ apiKey: "key", apiSecret: "secret", testnet: true });
    await a.fetchKlines("BTCUSDT", "1d", 1);
    assert.ok(
      stub.urls[0]!.startsWith("https://data-api.binance.vision/api/v3/klines"),
      `K 线必须走主网公开行情域，实际 ${stub.urls[0]}`,
    );

    stub.urls.length = 0;
    await a.placeOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 0.1 });
    assert.ok(
      stub.urls[0]!.startsWith("https://testnet.binance.vision/api/v3/order"),
      `测试网参数只应影响下单域，实际 ${stub.urls[0]}`,
    );
  } finally {
    stub.restore();
  }
});

test("Gate 现货：测试网连接拉 K 线仍走主网 api.gateio.ws", async () => {
  const stub = stubFetch(() => [
    ["1793491200", "1000", "105", "110", "90", "100", "500", "true"],
  ]);
  try {
    const a = new GateAdapter();
    a.init({ apiKey: "", apiSecret: "", testnet: true });
    await a.fetchKlines("BTC_USDT", "1d", 1);
    assert.ok(
      stub.urls[0]!.startsWith("https://api.gateio.ws/api/v4/spot/candlesticks"),
      `K 线必须走主网行情，实际 ${stub.urls[0]}`,
    );
    assert.ok(!stub.urls[0]!.includes("api-testnet"), "不能拿测试网 K 线冒充实盘");
  } finally {
    stub.restore();
  }
});

test("Gate 合约：公开行情固定主网，不受 testnet 标记影响", async () => {
  const stub = stubFetch(() => [
    { t: 1793491200, o: "100", c: "105", h: "110", l: "90", v: "500" },
  ]);
  try {
    const a = new GateFuturesAdapter();
    a.init({ apiKey: "", apiSecret: "", testnet: true });
    await a.fetchKlines("BTC_USDT", "1h", 1);
    assert.ok(
      stub.urls[0]!.startsWith("https://api.gateio.ws/api/v4/futures/usdt/candlesticks"),
      `合约 K 线必须走主网，实际 ${stub.urls[0]}`,
    );
  } finally {
    stub.restore();
  }
});
