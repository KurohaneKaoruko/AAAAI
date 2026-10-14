import assert from "node:assert/strict";
import test from "node:test";
import { EventBus, Topic } from "../src/core/eventBus.js";
import { PortfolioManager } from "../src/portfolio/portfolioManager.js";
import { RiskRules } from "../src/risk/rules.js";
import { runComparison } from "../src/bench/comparison.js";
import { testAdapter, testConfig } from "./helpers.js";
import type { Fill, OrderIntent, Side, Bar } from "../src/core/types.js";

function intent(symbol: string, side: Side, quantity: number, price: number): OrderIntent {
  return { symbol, side, quantity, price, timestamp: new Date(), reason: "test" };
}

function fill(i: OrderIntent, price: number, fee: number): Fill {
  return { order: i, price, fee, timestamp: i.timestamp };
}

function bar(symbol: string, close: number): Bar {
  return { symbol, timestamp: new Date(), open: close, high: close, low: close, close, volume: 1 };
}

test("PortfolioManager: 买入扣现金并建仓", () => {
  const bus = new EventBus();
  const pm = new PortfolioManager(bus, 10_000);
  bus.publish(Topic.FILL, fill(intent("X", "BUY", 10, 100), 100, 0.3));
  assert.equal(pm.cash, 10_000 - 1000 - 0.3);
  const pos = pm.position("X");
  assert.ok(pos);
  assert.equal(pos.quantity, 10);
  assert.equal(pos.avgCost, 100);
  assert.equal(pm.equity(), pm.cash + 10 * 100);
});

test("PortfolioManager: 加仓滚动均价、减仓结算已实现盈亏", () => {
  const bus = new EventBus();
  const pm = new PortfolioManager(bus, 10_000);
  bus.publish(Topic.FILL, fill(intent("X", "BUY", 10, 100), 100, 0));
  bus.publish(Topic.FILL, fill(intent("X", "BUY", 10, 200), 200, 0));
  assert.equal(pm.position("X")!.avgCost, 150, "加仓后均价应为 150");

  bus.publish(Topic.FILL, fill(intent("X", "SELL", 10, 180), 180, 0));
  assert.equal(pm.position("X")!.avgCost, 150, "减仓不改变均价");
  assert.equal(pm.realizedPnl(), 300, "(180-150)*10 = 300");
  assert.equal(pm.tradeHistory()[0]!.realizedPnl, 300);
  assert.equal(pm.tradeHistory().length, 3);
});

test("PortfolioManager: 卖出回收现金并清仓", () => {
  const bus = new EventBus();
  const pm = new PortfolioManager(bus, 10_000);
  bus.publish(Topic.FILL, fill(intent("X", "BUY", 10, 100), 100, 0));
  bus.publish(Topic.FILL, fill(intent("X", "SELL", 10, 120), 120, 0));
  assert.equal(pm.cash, 10_000 + 200);
  assert.equal(pm.position("X"), undefined);
  assert.equal(pm.metrics().totalFills, 2);
  assert.equal(pm.snapshot().positions.X, undefined);
});

test("PortfolioManager: 行情更新权益曲线", () => {
  const bus = new EventBus();
  const pm = new PortfolioManager(bus, 10_000);
  bus.publish(Topic.BAR, bar("X", 100));
  bus.publish(Topic.BAR, bar("X", 110));
  const curve = pm.equityCurve();
  assert.equal(curve.length, 2);
  assert.equal(curve[1]!.equity, 10_000);
  assert.equal(pm.drawdownPct, 0);
});

test("PortfolioManager: 权益下跌产生回撤", () => {
  const bus = new EventBus();
  const pm = new PortfolioManager(bus, 10_000);
  bus.publish(Topic.FILL, fill(intent("X", "BUY", 100, 100), 100, 0)); // 全仓
  bus.publish(Topic.BAR, bar("X", 90)); // 亏 10%
  assert.ok(pm.drawdownPct > 0.09, `回撤应约 10%, 实际 ${pm.drawdownPct}`);
});

test("RiskRules: 权重超限/回撤熔断", () => {
  const rules = new RiskRules({ maxPositionWeight: 0.6, maxOrderValue: 20_000, maxDrawdownPct: 0.15, minTradeValue: 0 });
  const signal = { symbol: "X", timestamp: new Date(), targetWeight: 0.9, confidence: 1, reason: "t" };
  assert.equal(rules.check({ ...signal, targetWeight: 0.3 }, 100_000, 0).allowed, true);
  const blocked = rules.check(signal, 100_000, 0);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /上限/);

  const meltdown = rules.check({ ...signal, targetWeight: 0.3 }, 100_000, 0.2);
  assert.equal(meltdown.allowed, false);
  assert.match(meltdown.reason, /熔断/);

  assert.equal(rules.check(signal, 0, 0).allowed, false);
  assert.equal(rules.check({ ...signal, targetWeight: -0.5 }, 100_000, 0).allowed, false);
});

test("RiskRules: 单笔金额截断", () => {
  const rules = new RiskRules({ maxPositionWeight: 1, maxOrderValue: 5000, maxDrawdownPct: 1, minTradeValue: 0 });
  assert.equal(rules.clampDeltaValue(999_999), 5000);
  assert.equal(rules.clampDeltaValue(-999_999), -5000);
  assert.equal(rules.clampDeltaValue(123), 123);
});


test("RiskRules: 最小调仓额过滤噪声单", () => {
  const strict = new RiskRules({ maxPositionWeight: 1, maxOrderValue: 100000, maxDrawdownPct: 1, minTradeValue: 1000 });
  assert.equal(strict.worthTrading(5000), true, "超过阈值应下单");
  assert.equal(strict.worthTrading(999.99), false, "低于阈值应忽略");
  assert.equal(strict.worthTrading(-3000), true, "卖出方向同样适用");
  assert.equal(strict.worthTrading(-200), false);

  const off = new RiskRules({ maxPositionWeight: 1, maxOrderValue: 100000, maxDrawdownPct: 1, minTradeValue: 0 });
  assert.equal(off.worthTrading(1), true, "阈值为 0 表示不限制");
  assert.equal(off.worthTrading(0.01), true);
});

test("最小调仓额：能显著减少成交笔数", async () => {
  const base = testConfig();
  const run = (minTradeValue: number) =>
    runComparison({ ...base, risk: { ...base.risk, minTradeValue } }, {
      adapter: testAdapter(), symbols: ["600519"], bars: 200, interval: "1m",
      liveTrading: false, runners: [{ id: "b", label: "b", kind: "baseline", client: null }],
    });
  const before = (await run(0)).results[0]!;
  const after = (await run(5000)).results[0]!;
  assert.ok(before.fillCount > 0, "基线本身应产生成交，否则该用例无意义");
  assert.ok(after.fillCount < before.fillCount, `设阈值后成交应减少: ${before.fillCount} -> ${after.fillCount}`);
});
