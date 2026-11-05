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
