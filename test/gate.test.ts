import assert from "node:assert/strict";
import test from "node:test";
import { GateAdapter, fromGatePair, toGatePair } from "../src/exchanges/gate.js";
import { listAdapterMetas, createAdapter } from "../src/exchanges/registry.js";

const noCred = { apiKey: "", apiSecret: "", testnet: false };

test("Gate 交易对格式转换（下划线 <-> 连续）", () => {
  assert.equal(toGatePair("BTCUSDT"), "BTC_USDT");
  assert.equal(toGatePair("btcusdt"), "BTC_USDT");
  assert.equal(toGatePair("ETHBTC"), "ETH_BTC");
  assert.equal(toGatePair("BTC_USDT"), "BTC_USDT", "已是下划线格式则原样返回");
  assert.equal(fromGatePair("BTC_USDT"), "BTCUSDT");
});

test("Gate 元信息完整且支持测试网", () => {
  const meta = new GateAdapter().meta;
  assert.equal(meta.id, "gate");
  assert.equal(meta.assetClass, "crypto");
  assert.equal(meta.supportsTrading, true);
  assert.equal(meta.requiresKeys, true);
  assert.equal(meta.supportsTestnet, true, "Gate 现货有官方测试网 api-testnet.gateapi.io");
  assert.ok(meta.klineIntervals.includes("1m"));
  assert.equal(meta.keyFields.length, 2);
});

test("Gate 已注册到目录与工厂（统一连接：现货 + 合约）", () => {
  const metas = listAdapterMetas();
  assert.ok(metas.some((m) => m.id === "gate"), "目录应包含 gate");
  assert.ok(!metas.some((m) => m.id === "gate-futures"), "gate-futures 已并入 gate，不应再有独立目录项");
  // 不带 tradingMode 的连接 = 现货模式（老 gate 连接的行为不变）
  const spot = createAdapter(
    { id: "x", adapterId: "gate", label: "g", testnet: false, enabled: true, createdAt: "" },
    { apiKey: "", apiSecret: "" },
  );
  assert.equal(spot.meta.id, "gate");
  assert.equal(spot.meta.tradingMode, "spot", "缺省按现货");
  // tradingMode=futures 的连接 = 合约模式（老 gate-futures 的行为）
  const futures = createAdapter(
    { id: "x", adapterId: "gate", label: "g", testnet: false, enabled: true, createdAt: "", tradingMode: "futures" },
    { apiKey: "", apiSecret: "" },
  );
  assert.equal(futures.meta.tradingMode, "futures", "连接选了合约模式");
  assert.ok((futures.meta.defaultSymbols ?? []).some((s) => s.name.includes("永续")), "合约模式的常用清单应是永续合约");
});

test("Gate: 未配置 Key 时下单被拒绝而不是抛错", async () => {
  const gate = new GateAdapter();
  gate.init(noCred);
  const result = await gate.placeOrder({
    symbol: "BTCUSDT",
    side: "BUY",
    type: "MARKET",
    quantity: 0.1,
  });
  assert.equal(result.status, "rejected");
  assert.match(result.message ?? "", /API Key/);
});

test("Gate: 数量非法时返回可读错误", async () => {
  const gate = new GateAdapter();
  gate.init({ apiKey: "k", apiSecret: "s", testnet: false });
  const result = await gate.placeOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 0 });
  assert.equal(result.status, "rejected");
  assert.match(result.message ?? "", /数量/);
});

test("Gate: 连通性测试返回结构化结果（不抛异常）", async () => {
  const gate = new GateAdapter();
  gate.init(noCred);
  const result = await gate.testConnection();
  assert.equal(typeof result.ok, "boolean");
  assert.ok(result.message.length > 0);
});