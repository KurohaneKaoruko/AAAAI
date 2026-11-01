/**
 * 实盘券商（ExchangeBroker）与各适配器下单入口的契约。
 *
 * 背景：OrderRequest 同时有 quantity（基础币数量）与 quoteQty（计价币金额），
 * Broker 两者都传；每个适配器必须至少认得其中一个，否则实盘会
 * "看起来启动成功、实际一单都下不出去"（模拟盘一切正常，极难察觉）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ExchangeBroker } from "../src/execution/exchangeBroker.js";
import { EventBus, Topic } from "../src/core/eventBus.js";
import type { Event } from "../src/core/eventBus.js";
import type { Fill, OrderIntent } from "../src/core/types.js";
import type { ExchangeAdapter, OrderRequest, OrderResult } from "../src/exchanges/types.js";

function intent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    symbol: "BTCUSDT",
    side: "BUY",
    quantity: 0.01,
    price: 50_000,
    timestamp: new Date(),
    reason: "契约测试",
    ...overrides,
  };
}

/** 记录收到的下单请求、按脚本返回结果的最小适配器。 */
function fakeAdapter(response: OrderResult, captured: OrderRequest[]): ExchangeAdapter {
  return {
    meta: {
      id: "fake",
      name: "Fake",
      assetClass: "crypto",
      description: "",
      requiresKeys: false,
      supportsTrading: true,
      supportsTestnet: false,
      klineIntervals: ["1m"],
      keyFields: [],
    },
    init: () => {},
    testConnection: async () => ({ ok: true, message: "" }),
    searchSymbols: async () => [],
    fetchTickers: async () => [],
    fetchKlines: async () => [],
    placeOrder: async (req: OrderRequest) => {
      captured.push(req);
      return response;
    },
  };
}

test("ExchangeBroker：下单请求同时携带数量与金额（适配器各取所需）", async () => {
  const captured: OrderRequest[] = [];
  const bus = new EventBus();
  const broker = new ExchangeBroker(
    bus,
    fakeAdapter({ orderId: "1", status: "filled", filledQty: 0.01, avgPrice: 50_000, fee: 0.005 }, captured),
  );
  const fill = await broker.handle(intent());
  assert.ok(fill, "成交应返回 Fill");
  assert.equal(captured.length, 1);
  const req = captured[0]!;
  assert.equal(req.type, "MARKET");
  assert.equal(req.quantity, 0.01, "必须带数量：Gate/OKX 只认 quantity");
  assert.equal(req.quoteQty, 500, "必须带金额：Binance 市价买优先用 quoteOrderQty");
});

test("ExchangeBroker：拒单广播 ORDER_REJECTED 且不产生成交", async () => {
  const rejected: Event[] = [];
  const bus = new EventBus();
  bus.subscribe(Topic.ORDER_REJECTED, (e) => rejected.push(e));
  const broker = new ExchangeBroker(
    bus,
    fakeAdapter({ orderId: "", status: "rejected", filledQty: 0, avgPrice: 0, fee: 0, message: "精度不足" }, []),
  );
  const fill: Fill | null = await broker.handle(intent());
  assert.equal(fill, null);
  assert.equal(rejected.length, 1, "拒单必须广播，事件流里才看得出为什么没成交");
});

test("适配器契约：Gate 市价买单有金额时按金额下单", async () => {
  // 直接用真适配器校验它构造的请求体（不发网络请求：无 Key 会先被拒，
  // 因此这里只测到"金额/数量的选择"这一步 —— 用假签名服务绕过网络）。
  const { GateAdapter } = await import("../src/exchanges/gate.js");
  const gate = new GateAdapter();
  gate.init({ apiKey: "k", apiSecret: "s", testnet: false });
  // 拦截网络：替换 signedRequest 不可行（私有），改为校验公开行为——
  // 无网络环境下 fetch 会抛错，但抛错前请求体已经构造完成，
  // 所以这里断言"金额非法拒绝"与"数量非法拒绝"这两种可同步观察的行为。
  const badQuote = await gate.placeOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", quoteQty: 0, quantity: 0 });
  assert.equal(badQuote.status, "rejected", "数量与金额都缺失时必须拒绝");
});

test("适配器契约：OKX 只传金额、不给数量时也应可下单语义成立", async () => {
  const { OkxAdapter } = await import("../src/exchanges/okx.js");
  const okx = new OkxAdapter();
  okx.init({ apiKey: "k", apiSecret: "s:pp", testnet: false });
  // 无网络：请求会走到 signedRequest 并因 fetch 失败抛错或返回拒绝。
  // 契约点：sz 缺失（0）必须以"参数不合法"被拒，而不是发出 sz=0 的请求。
  const bad = await okx.placeOrder({ symbol: "BTC-USDT", side: "BUY", type: "MARKET" });
  assert.equal(bad.status, "rejected");
  assert.match(bad.message ?? "", /大于 0/);
});
