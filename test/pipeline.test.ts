import assert from "node:assert/strict";
import test from "node:test";
import { EventBus } from "../src/core/eventBus.js";
import { Topic } from "../src/core/eventBus.js";
import { PortfolioManager } from "../src/portfolio/portfolioManager.js";
import { RiskRules } from "../src/risk/rules.js";
import type { Fill, OrderIntent, Side } from "../src/core/types.js";
import type { Bar } from "../src/core/types.js";

function intent(symbol: string, side: Side, quantity: number, price: number): OrderIntent {
  return { symbol, side, quantity, price, timestamp: new Date(), reason: "test" };
}

function fill(i: OrderIntent, price: number, fee: number): Fill {
  return { order: i, price, fee, timestamp: i.timestamp };
}

function bar(symbol: string, close: number): Bar {
  return {
    symbol,
    timestamp: new Date(),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  };
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

test("PortfolioManager: 卖出回收现金并清仓", () => {
  const bus = new EventBus();
  const pm = new PortfolioManager(bus, 10_000);
  bus.publish(Topic.FILL, fill(intent("X", "BUY", 10, 100), 100, 0));
  bus.publish(Topic.FILL, fill(intent("X", "SELL", 10, 120), 120, 0));
  assert.equal(pm.cash, 10_000 + 200);
  assert.equal(pm.position("X"), undefined);
  assert.equal(pm.metrics().totalFills, 2);
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

test("RiskRules: 权重超限/回撤熔断", () => {
  const rules = new RiskRules({
    maxPositionWeight: 0.6,
    maxOrderValue: 20_000,
    maxDrawdownPct: 0.15,
  });
  const signal = { symbol: "X", timestamp: new Date(), targetWeight: 0.9, confidence: 1, reason: "t" };
  assert.equal(rules.check({ ...signal, targetWeight: 0.3 }, 100_000, 0).allowed, true);
  const blocked = rules.check(signal, 100_000, 0);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /上限/);

  const meltdown = rules.check({ ...signal, targetWeight: 0.3 }, 100_000, 0.2);
  assert.equal(meltdown.allowed, false);
  assert.match(meltdown.reason, /熔断/);

  assert.equal(rules.check(signal, 0, 0).allowed, false);
});

test("RiskRules: 单笔金额截断", () => {
  const rules = new RiskRules({ maxPositionWeight: 1, maxOrderValue: 5000, maxDrawdownPct: 1 });
  assert.equal(rules.clampDeltaValue(999_999), 5000);
  assert.equal(rules.clampDeltaValue(-999_999), -5000);
  assert.equal(rules.clampDeltaValue(123), 123);
});
