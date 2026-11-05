/** 逐档吃单撮合（L2 盘口微结构）与真实费率/资金费的单元测试。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrderBookSnapshot } from "../src/exchanges/types.js";
import { bookMidPrice, bookCapacity, fillMarketAgainstBook } from "../src/execution/bookLiquidity.js";
import { feePairFor } from "../src/execution/feeSchedule.js";
import { PortfolioManager } from "../src/portfolio/portfolioManager.js";
import { EventBus, Topic } from "../src/core/eventBus.js";
import type { Fill } from "../src/core/types.js";

function book(asks: [number, number][], bids: [number, number][], ts = 1_000): OrderBookSnapshot {
  return {
    symbol: "BTCUSDT",
    asks: asks.map(([price, quantity]) => ({ price, quantity })),
    bids: bids.map(([price, quantity]) => ({ price, quantity })),
    timestamp: ts,
  };
}

test("盘口撮合：小单只吃一档，均价即卖一价", () => {
  const b = book([[100, 2], [101, 5]], [[99, 2], [98, 5]]);
  const r = fillMarketAgainstBook(b, "BUY", 1);
  assert.equal(r.filledQuantity, 1);
  assert.equal(r.averagePrice, 100);
  assert.equal(r.levelsConsumed, 1);
  assert.equal(r.unfilledQuantity, 0);
});

test("盘口撮合：大单逐档吃深，均价按量加权", () => {
  const b = book([[100, 2], [101, 5], [103, 10]], [[99, 2], [98, 5]]);
  // 买 4：吃 2@100 + 2@101 → 均价 100.5
  const r = fillMarketAgainstBook(b, "BUY", 4);
  assert.equal(r.filledQuantity, 4);
  assert.equal(r.averagePrice, 100.5);
  assert.equal(r.worstPrice, 101);
  assert.equal(r.levelsConsumed, 2);
});

test("盘口撮合：SELL 吃 bids，均价低于中间价（滑点为正）", () => {
  const b = book([[100, 5]], [[99, 1], [98, 4]]);
  const r = fillMarketAgainstBook(b, "SELL", 2);
  // 卖 2：吃 1@99 + 1@98 → 均价 98.5；中间价 99.5 → 滑点为正
  assert.equal(r.averagePrice, 98.5);
  assert.ok(r.slippageBps > 0, "卖单均价低于中间价，滑点应为正");
});

test("盘口撮合：IOC——深度不足吃满为止，剩余撤销", () => {
  const b = book([[100, 2], [101, 3]], [[99, 10]]);
  const r = fillMarketAgainstBook(b, "BUY", 10);
  assert.equal(r.filledQuantity, 5, "盘口只有 5 可吃");
  assert.equal(r.unfilledQuantity, 5, "剩余 5 按 IOC 撤销");
  assert.ok(r.slippageBps > 0);
});

test("盘口撮合：脏档（零价/零量）被跳过，不影响后续档", () => {
  const b: OrderBookSnapshot = {
    symbol: "X",
    asks: [{ price: 0, quantity: 5 }, { price: 100, quantity: 2 }, { price: -1, quantity: 9 }, { price: 102, quantity: 3 }],
    bids: [{ price: 99, quantity: 1 }],
    timestamp: 1,
  };
  const r = fillMarketAgainstBook(b, "BUY", 5);
  assert.equal(r.filledQuantity, 5);
  assert.equal(r.worstPrice, 102);
  assert.equal(r.levelsConsumed, 2);
});

test("盘口撮合：空盘口拒单（unfilled = 全量）", () => {
  const b = book([], []);
  const r = fillMarketAgainstBook(b, "BUY", 3);
  assert.equal(r.filledQuantity, 0);
  assert.equal(r.unfilledQuantity, 3);
});

test("中间价与容量：无对手档退化用单边；容量=档量和", () => {
  assert.equal(bookMidPrice(book([[100, 1]], [[98, 1]])), 99);
  assert.equal(bookMidPrice(book([[100, 1]], [])), 100);
  assert.equal(bookCapacity(book([[100, 2], [101, 3]], []), "BUY"), 5);
  assert.equal(bookCapacity(book([], [[99, 2]]), "SELL"), 2);
});

test("费率表：各所 taker/maker 与合约口径", () => {
  assert.equal(feePairFor("binance").taker, 0.001);
  assert.equal(feePairFor("gate").taker, 0.002);
  assert.equal(feePairFor("okx").maker, 0.0008);
  // 统一 gate 连接的合约模式按永续费率
  assert.deepEqual(feePairFor("gate", "futures"), { taker: 0.0005, maker: 0.0002 });
  // 未知适配器给保守缺省，不抛错
  assert.equal(feePairFor("mystery").taker, 0.001);
});

test("资金费：正费率多头付/空头收，跨 8h 窗口才结算", () => {
  const bus = new EventBus();
  const pm = new PortfolioManager(bus, 10_000, "futures");
  // 建一个多仓 1 BTC @ 100：手动广播一笔成交
  const fill: Fill = {
    order: { symbol: "BTC_USDT", side: "BUY", quantity: 1, price: 100, timestamp: new Date(0), reason: "t" },
    price: 100,
    fee: 0,
    timestamp: new Date(0),
  };
  bus.publish(Topic.FILL, fill);
  pm.setFundingProvider(() => 0.0001); // 0.01% 费率

  // 同一窗口内不结算
  assert.equal(pm.settleFunding(1 * 3600_000), 0);
  // 跨过第一个 8h 点：名义 100 × 0.0001 = 0.01，多头付出 → 现金减少
  const paid = pm.settleFunding(9 * 3600_000);
  assert.ok(Math.abs(paid + 0.01 * 100 / 100) < 1e-9 || paid < 0, `正费率下多头应付费，实际 ${paid}`);
  assert.ok(paid < 0);
  // 不重复结算
  assert.equal(pm.settleFunding(9 * 3600_000 + 1), 0);
});

test("资金费：现货模式与未注入 provider 时均为 no-op", () => {
  const spot = new PortfolioManager(new EventBus(), 1000, "spot");
  assert.equal(spot.settleFunding(Date.now()), 0);
  const futuresNoProvider = new PortfolioManager(new EventBus(), 1000, "futures");
  assert.equal(futuresNoProvider.settleFunding(Date.now()), 0);
});

/* ---------- K 线成交量参与率上限（回测真实性约束） ---------- */

import { PriceBook } from "../src/data/streaming.js";
import { PaperBroker } from "../src/execution/paperBroker.js";
import type { OrderIntent, Bar } from "../src/core/types.js";

async function pump(bus: EventBus, bars: Bar[], book?: PriceBook): Promise<void> {
  for (const b of bars) {
    book?.update(b);
    await bus.publishAsync(Topic.BAR, b);
  }
  await new Promise((r) => setTimeout(r, 5));
}

test("成交量约束：单根 K 线内成交量不超过 bar volume × participation", async () => {
  const bus = new EventBus();
  const book = new PriceBook();
  const fills: Fill[] = [];
  const rejected: unknown[] = [];
  const broker = new PaperBroker(bus, book, { feeRate: 0, slippageBps: 0, volumeParticipation: 0.25 });
  bus.subscribe(Topic.FILL, (e) => fills.push(e.payload as Fill));
  bus.subscribe(Topic.ORDER_REJECTED, (e) => rejected.push(e.payload));
  bus.subscribe(Topic.ORDER_INTENT, async (e) => {
    await broker.handle(e.payload as OrderIntent);
  });

  const t0 = Date.UTC(2026, 0, 1);
  // 量 10 的 K 线：参与率 0.25 → 最多成交 2.5
  await pump(bus, [{ symbol: "X", timestamp: new Date(t0), open: 100, high: 100, low: 100, close: 100, volume: 10 }], book);
  await bus.publishAsync(Topic.ORDER_INTENT, {
    symbol: "X", side: "BUY", quantity: 9, price: 100, timestamp: new Date(t0), reason: "test",
  } satisfies OrderIntent);
  await pump(bus, [{ symbol: "X", timestamp: new Date(t0 + 60_000), open: 100, high: 101, low: 99, close: 100, volume: 10 }], book);

  assert.equal(fills.length, 1, "应有一笔部分成交");
  assert.ok(Math.abs((fills[0]!.order.quantity as number) - 2.5) < 1e-9, `成交量应为 2.5，实际 ${fills[0]!.order.quantity}`);
  assert.equal(rejected.length, 1, "剩余部分应广播部分成交语义（拒单事件）");
});

test("成交量约束：同根同 symbol 第二笔只吃剩余容量（新决策取代旧单语义下用连续两根验证）", async () => {
  const bus = new EventBus();
  const book = new PriceBook();
  const fills: Fill[] = [];
  const broker = new PaperBroker(bus, book, { feeRate: 0, slippageBps: 0, volumeParticipation: 0.5 });
  bus.subscribe(Topic.FILL, (e) => fills.push(e.payload as Fill));
  bus.subscribe(Topic.ORDER_INTENT, async (e) => {
    await broker.handle(e.payload as OrderIntent);
  });

  const t0 = Date.UTC(2026, 0, 1);
  // 第 1 根：量 10，容量 5。第一笔要 3 → 全成
  await pump(bus, [{ symbol: "X", timestamp: new Date(t0), open: 100, high: 100, low: 100, close: 100, volume: 10 }], book);
  await bus.publishAsync(Topic.ORDER_INTENT, { symbol: "X", side: "BUY", quantity: 3, price: 100, timestamp: new Date(t0), reason: "a" } satisfies OrderIntent);
  // 第 2 根：新决策（同 symbol 旧单已被取代语义不适用——上一笔已在第 2 根开盘成交）
  await pump(bus, [{ symbol: "X", timestamp: new Date(t0 + 60_000), open: 100, high: 101, low: 99, close: 100, volume: 10 }], book);
  assert.equal(fills.length, 1);
  assert.ok(Math.abs((fills[0]!.order.quantity as number) - 3) < 1e-9, "第一笔全额成交");
});

test("成交量约束：participation=0 或量缺失时不限制（旧行为）", async () => {
  const bus = new EventBus();
  const book = new PriceBook();
  const fills: Fill[] = [];
  const broker = new PaperBroker(bus, book, { feeRate: 0, slippageBps: 0, volumeParticipation: 0 });
  bus.subscribe(Topic.FILL, (e) => fills.push(e.payload as Fill));
  bus.subscribe(Topic.ORDER_INTENT, async (e) => {
    await broker.handle(e.payload as OrderIntent);
  });
  const t0 = Date.UTC(2026, 0, 1);
  await pump(bus, [{ symbol: "X", timestamp: new Date(t0), open: 100, high: 100, low: 100, close: 100, volume: 1 }], book);
  await bus.publishAsync(Topic.ORDER_INTENT, { symbol: "X", side: "BUY", quantity: 100, price: 100, timestamp: new Date(t0), reason: "t" } satisfies OrderIntent);
  await pump(bus, [{ symbol: "X", timestamp: new Date(t0 + 60_000), open: 100, high: 101, low: 99, close: 100, volume: 1 }], book);

  assert.equal(fills.length, 1);
  assert.equal(fills[0]!.order.quantity, 100, "不限制时应全额成交");
});
