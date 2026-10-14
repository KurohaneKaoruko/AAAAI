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

test("Gate 元信息完整且无测试网", () => {
  const meta = new GateAdapter().meta;
  assert.equal(meta.id, "gate");
  assert.equal(meta.assetClass, "crypto");
  assert.equal(meta.supportsTrading, true);
  assert.equal(meta.requiresKeys, true);
  assert.equal(meta.supportsTestnet, false, "现货无官方测试网");
  assert.ok(meta.klineIntervals.includes("1m"));
  assert.equal(meta.keyFields.length, 2);
});

test("Gate 已注册到目录与工厂", () => {
  const metas = listAdapterMetas();
  assert.ok(metas.some((m) => m.id === "gate"), "目录应包含 gate");
  const adapter = createAdapter(
    { id: "x", adapterId: "gate", label: "g", testnet: false, enabled: true, createdAt: "" },
    { apiKey: "", apiSecret: "" },
  );
  assert.ok(adapter instanceof GateAdapter);
  assert.equal(adapter.meta.id, "gate");
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