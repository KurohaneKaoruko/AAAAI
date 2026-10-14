import assert from "node:assert/strict";
import test from "node:test";
import { EventBus, Topic } from "../src/core/eventBus.js";
import { PriceBook } from "../src/data/streaming.js";
import { PortfolioManager } from "../src/portfolio/portfolioManager.js";
import { PaperBroker } from "../src/execution/paperBroker.js";
import { SimulatedAdapter } from "../src/exchanges/simulated.js";
import { BinanceAdapter } from "../src/exchanges/binance.js";
import { OkxAdapter } from "../src/exchanges/okx.js";
import { EastmoneyAdapter } from "../src/exchanges/eastmoney.js";
import { StooqAdapter } from "../src/exchanges/stooq.js";
import { toStooqSymbol, fromStooqSymbol } from "../src/exchanges/stooq.js";
import { secidOf } from "../src/exchanges/eastmoney.js";
import { listAdapterMetas, createAdapter } from "../src/exchanges/registry.js";
import type { OrderIntent } from "../src/core/types.js";

const noCred = { apiKey: "", apiSecret: "", testnet: false };

test("SimulatedAdapter: 行情可复现且 K 线自洽", async () => {
  const a = new SimulatedAdapter();
  a.init(noCred);
  const k1 = await a.fetchKlines("DEMO-BTC", "1m", 40);
  const b = new SimulatedAdapter();
  b.init(noCred);
  const k2 = await b.fetchKlines("DEMO-BTC", "1m", 40);
  assert.equal(k1.length, 40);
  assert.deepEqual(k1.map((x) => x.close), k2.map((x) => x.close), "同代码行情必须可复现");
  for (const bar of k1) {
    assert.ok(bar.high >= Math.max(bar.open, bar.close) - 1e-9);
    assert.ok(bar.low <= Math.min(bar.open, bar.close) + 1e-9);
    assert.ok(bar.close > 0);
  }
  const times = k1.map((k) => k.timestamp.getTime());
  assert.deepEqual(times, [...times].sort((x, y) => x - y), "K 线必须按时间升序");
});

test("SimulatedAdapter: 搜索与快照", async () => {
  const a = new SimulatedAdapter();
  a.init(noCred);
  const all = await a.searchSymbols("");
  assert.ok(all.length >= 3);
  const filtered = await a.searchSymbols("BTC");
  assert.equal(filtered[0]?.symbol, "DEMO-BTC");
  const tickers = await a.fetchTickers(["DEMO-BTC", "600519"]);
  assert.equal(tickers.length, 2);
  for (const t of tickers) {
    assert.ok(t.price > 0);
    assert.ok(Number.isFinite(t.changePct));
  }
});

test("SimulatedAdapter: 模拟成交含手续费", async () => {
  const a = new SimulatedAdapter();
  a.init(noCred);
  const order = await a.placeOrder({ symbol: "DEMO-BTC", side: "BUY", type: "MARKET", quoteQty: 1000 });
  assert.equal(order.status, "filled");
  assert.ok(order.avgPrice > 0);
  assert.ok(order.fee > 0);
  const bad = await a.placeOrder({ symbol: "DEMO-BTC", side: "BUY", type: "MARKET", quantity: 0 });
  assert.equal(bad.status, "rejected");
});

test("适配器元信息完整：6 家交易所", () => {
  const metas = listAdapterMetas();
  const ids = metas.map((m) => m.id);
  assert.deepEqual(ids.sort(), ["binance", "eastmoney", "gate", "okx", "simulated", "stooq"]);
  for (const m of metas) {
    assert.ok(m.name.length > 0, `${m.id} 缺少名称`);
    assert.ok(m.description.length > 0, `${m.id} 缺少描述`);
    assert.ok(Array.isArray(m.klineIntervals) && m.klineIntervals.length > 0, `${m.id} 缺少周期列表`);
    assert.ok(["crypto", "stock", "mixed"].includes(m.assetClass));
  }
  // 股票源仅行情，加密源支持下单
  assert.equal(metas.find((m) => m.id === "eastmoney")!.supportsTrading, false);
  assert.equal(metas.find((m) => m.id === "stooq")!.supportsTrading, false);
  assert.equal(metas.find((m) => m.id === "binance")!.supportsTrading, true);
  assert.equal(metas.find((m) => m.id === "okx")!.supportsTrading, true);
  assert.equal(metas.find((m) => m.id === "gate")!.supportsTrading, true);
});

test("createAdapter 按连接创建对应实例", () => {
  const conn = { id: "x", adapterId: "binance", label: "b", testnet: true, enabled: true, createdAt: "" };
  const adapter = createAdapter(conn, { apiKey: "", apiSecret: "" });
  assert.ok(adapter instanceof BinanceAdapter);
  assert.throws(
    () => createAdapter({ ...conn, adapterId: "nope" }, { apiKey: "", apiSecret: "" }),
    /未知的交易所适配器/,
  );
});

test("PaperBroker: 成交含滑点与手续费，组合正确记账", async () => {
  const bus = new EventBus();
  const book = new PriceBook();
  const portfolio = new PortfolioManager(bus, 10_000);
  const broker = new PaperBroker(bus, book, { feeRate: 0.001, slippageBps: 10 });
  bus.subscribe(Topic.ORDER_INTENT, async (e) => {
    await broker.handle(e.payload as OrderIntent);
  });

  book.update({ symbol: "X", timestamp: new Date(), open: 100, high: 100, low: 100, close: 100, volume: 1 });
  await bus.publishAsync(Topic.ORDER_INTENT, {
    symbol: "X",
    side: "BUY",
    quantity: 1,
    price: 100,
    timestamp: new Date(),
    reason: "test",
  } satisfies OrderIntent);

  // 滑点 +10bps -> 100.1；手续费 0.1%
  assert.equal(portfolio.cash, 10_000 - 100.1 - 0.1001);
  const pos = portfolio.position("X");
  assert.ok(pos && Math.abs(pos.quantity - 1) < 1e-9);
  assert.equal(portfolio.metrics().totalFills, 1);
  assert.equal(portfolio.tradeHistory().length, 1);
  assert.equal(portfolio.tradeHistory()[0]!.side, "BUY");
});

test("PaperBroker: 无行情的订单被驳回", async () => {
  const bus = new EventBus();
  const portfolio = new PortfolioManager(bus, 5000);
  const broker = new PaperBroker(bus, new PriceBook(), { feeRate: 0, slippageBps: 0 });
  const rejected: unknown[] = [];
  bus.subscribe(Topic.ORDER_REJECTED, (e) => rejected.push(e.payload));

  await broker.handle({
    symbol: "NOPE",
    side: "BUY",
    quantity: 1,
    price: 1,
    timestamp: new Date(),
    reason: "test",
  });
  assert.equal(rejected.length, 1);
  assert.equal(portfolio.metrics().totalFills, 0);
});

test("交易所代码规则：Stooq / 东财", () => {
  assert.equal(toStooqSymbol("AAPL"), "aapl.us");
  assert.equal(toStooqSymbol("msft.us"), "msft.us");
  assert.equal(fromStooqSymbol("aapl.us"), "AAPL");
  assert.equal(secidOf("600519"), "1.600519");
  assert.equal(secidOf("000001"), "0.000001");
  assert.equal(secidOf("1.600519"), "1.600519");
});

test("无网络环境下连接测试应失败而非崩溃", async () => {
  const binance = new BinanceAdapter();
  binance.init(noCred);
  const result = await binance.testConnection();
  assert.equal(typeof result.ok, "boolean");
  assert.ok(result.message.length > 0);

  const okx = new OkxAdapter();
  okx.init(noCred);
  assert.ok((await okx.testConnection()).message.length > 0);

  const em = new EastmoneyAdapter();
  em.init(noCred);
  assert.ok((await em.testConnection()).message.length > 0);

  const stooq = new StooqAdapter();
  stooq.init(noCred);
  assert.ok((await stooq.testConnection()).message.length > 0);
});
test("常用标的清单：每个交易所都提供且字段合法", async () => {
  const { listAdapterMetas } = await import("../src/exchanges/registry.js");
  for (const meta of listAdapterMetas()) {
    const list = meta.defaultSymbols ?? [];
    assert.ok(list.length >= 4, `${meta.id} 常用标的过少: ${list.length}`);
    for (const s of list) {
      assert.ok(s.symbol && s.symbol.length > 0, `${meta.id} 存在空代码`);
      assert.ok(s.name && s.name.length > 0, `${s.symbol} 缺少名称`);
      assert.ok(["crypto", "stock"].includes(s.assetClass), `${s.symbol} 品类非法`);
      assert.ok(s.currency.length > 0, `${s.symbol} 缺少计价货币`);
      assert.ok(s.lotSize >= 1, `${s.symbol} 最小单位非法`);
      assert.ok(s.qtyPrecision >= 0 && s.pricePrecision >= 0);
    }
    // 代码不应重复
    const codes = list.map((s) => s.symbol);
    assert.equal(new Set(codes).size, codes.length, `${meta.id} 清单存在重复代码`);
  }
});

test("常用标的：股票源覆盖 A股与美股两类代码", async () => {
  const { listAdapterMetas } = await import("../src/exchanges/registry.js");
  const byId = new Map(listAdapterMetas().map((m) => [m.id, m]));
  // A 股：6 位数字代码
  const em = byId.get("eastmoney")!.defaultSymbols!;
  assert.ok(em.some((s) => /^\d{6}$/.test(s.symbol) && s.currency === "CNY"), "东财清单应含 A 股 6 位代码");
  // 美股：字母代码
  const stooq = byId.get("stooq")!.defaultSymbols!;
  assert.ok(stooq.some((s) => /^[A-Z.]+$/.test(s.symbol) && s.currency === "USD"), "Stooq 清单应含美股字母代码");
  // 加密：配对代码
  assert.ok(byId.get("binance")!.defaultSymbols!.some((s) => s.symbol.endsWith("USDT")));
  assert.ok(byId.get("okx")!.defaultSymbols!.some((s) => s.symbol.includes("-")));
  assert.ok(byId.get("gate")!.defaultSymbols!.some((s) => s.symbol.includes("_")));
});
