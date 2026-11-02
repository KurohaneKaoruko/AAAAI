/** 合约模式：保证金记账、做空、风控与双均线双向信号。 */

import assert from "node:assert/strict";
import test from "node:test";
import { EventBus, Topic } from "../src/core/eventBus.js";
import type { Bar, Fill, OrderIntent } from "../src/core/types.js";
import { PortfolioManager } from "../src/portfolio/portfolioManager.js";
import { RiskRules } from "../src/risk/rules.js";
import { RiskGuardAgent } from "../src/agents/riskGuard.js";
import { PriceBook } from "../src/data/streaming.js";
import { MomentumStrategy } from "../src/strategies/momentum.js";
import { SimulatedFuturesAdapter } from "../src/exchanges/simulatedFutures.js";
import { isSimulatedMarket } from "../src/exchanges/types.js";
import { runWinRate } from "../src/validation/winRate.js";
import { testConfig } from "./helpers.js";

function fill(order: OrderIntent, price: number, fee = 0): Fill {
  return { order, price, fee, timestamp: new Date() };
}
function intent(side: "BUY" | "SELL", quantity: number, symbol = "X"): OrderIntent {
  return { symbol, side, quantity, price: 0, timestamp: new Date(), reason: "test" };
}
function bar(close: number, symbol = "X"): Bar {
  return { symbol, timestamp: new Date(), open: close, high: close, low: close, close, volume: 1 };
}

test("合约记账：开空不增加现金，价格下跌产生未实现盈利，平仓结算", () => {
  const bus = new EventBus();
  const pm = new PortfolioManager(bus, 10_000, "futures");
  bus.publish(Topic.FILL, fill(intent("SELL", 10), 100));
  assert.equal(pm.cash, 10_000, "开空不产生现金流，只占用保证金");
  assert.equal(pm.position("X")!.quantity, -10);
  bus.publish(Topic.BAR, bar(90));
  assert.equal(pm.equity(), 10_100, "空头下跌 10 元 × 10 枚 = +100");
  bus.publish(Topic.FILL, fill(intent("BUY", 10), 90));
  assert.equal(pm.position("X"), undefined);
  assert.equal(pm.cash, 10_100);
  assert.equal(pm.realizedPnl(), 100);
});

test("合约记账：多头权益等于保证金现金 + 未实现盈亏；反手先结旧仓再开新仓", () => {
  const bus = new EventBus();
  const pm = new PortfolioManager(bus, 10_000, "futures");
  bus.publish(Topic.FILL, fill(intent("BUY", 10), 100));
  bus.publish(Topic.BAR, bar(110));
  assert.equal(pm.equity(), 10_100);
  // 反手：卖 15 = 平掉 10 多头 + 开 5 空头
  bus.publish(Topic.FILL, fill(intent("SELL", 15), 110));
  assert.equal(pm.position("X")!.quantity, -5);
  assert.equal(pm.position("X")!.avgCost, 110);
  assert.equal(pm.cash, 10_100);
  // 继续跌到 100：空头 5 枚赚 50
  bus.publish(Topic.BAR, bar(100));
  assert.equal(pm.equity(), 10_150);
});

test("风控：高价标的下单不会被「金额 < 单价」误杀", () => {
  const bus = new EventBus();
  const book = new PriceBook();
  const pm = new PortfolioManager(bus, 100_000, "futures");
  book.update({ symbol: "BTC_USDT", timestamp: new Date(), open: 80_000, high: 80_000, low: 80_000, close: 80_000, volume: 1 });
  const guard = new RiskGuardAgent(
    bus,
    new RiskRules({
      maxPositionWeight: 0.6,
      maxOrderValue: 20_000,
      maxDrawdownPct: 1,
      minTradeValue: 0,
      mode: "futures",
      grossCap: 1,
    }),
    pm,
    book,
    "futures",
  );
  guard.attach();
  const intents: OrderIntent[] = [];
  bus.subscribe(Topic.ORDER_INTENT, (e) => intents.push(e.payload as OrderIntent));
  bus.publish(Topic.SIGNAL, {
    symbol: "BTC_USDT",
    timestamp: new Date(),
    targetWeight: 0.5,
    confidence: 1,
    reason: "test",
  });
  assert.equal(intents.length, 1, "8 万 U 的 BTC 上 2 万 U 的订单是正常订单，必须放行");
  assert.ok(Math.abs(intents[0]!.quantity - 20_000 / 80_000) < 1e-9);
});

test("风控：现货拒绝负权重，合约允许负权重并限制绝对值", () => {
  const spot = new RiskRules({ maxPositionWeight: 0.6, maxOrderValue: 20_000, maxDrawdownPct: 1, minTradeValue: 0 });
  const futures = new RiskRules({
    maxPositionWeight: 0.6,
    maxOrderValue: 20_000,
    maxDrawdownPct: 1,
    minTradeValue: 0,
    mode: "futures",
    grossCap: 1,
  });
  const signal = { symbol: "X", timestamp: new Date(), targetWeight: -0.5, confidence: 1, reason: "t" };
  assert.equal(spot.check(signal, 100_000, 0).allowed, false);
  assert.equal(futures.check(signal, 100_000, 0).allowed, true);
  assert.equal(futures.check({ ...signal, targetWeight: -0.8 }, 100_000, 0).allowed, false);
});

test("双均线：下跌趋势在允许做空时输出负仓位，不允许时保持空仓", async () => {
  const bars = Array.from({ length: 40 }, (_, i) => bar(200 - i * 2));
  const short = new MomentumStrategy(2, 8, 0.5, true);
  const longOnly = new MomentumStrategy(2, 8, 0.5, false);
  const s1 = await short.generate({ symbol: "X", bars });
  const s2 = await longOnly.generate({ symbol: "X", bars });
  assert.ok(s1 && s1.targetWeight < 0, `下跌趋势应给出负仓位，实际 ${s1?.targetWeight}`);
  assert.equal(s2?.targetWeight, 0, "现货模式不得输出负仓位");
});

test("模拟合约适配器：行情标记为 simulated，交易模式为 futures", async () => {
  const adapter = new SimulatedFuturesAdapter();
  adapter.init({ apiKey: "", apiSecret: "", testnet: false });
  assert.equal(adapter.meta.tradingMode, "futures");
  assert.equal(isSimulatedMarket(adapter), true);
  assert.ok(adapter.meta.notes?.some((n) => n.includes("强平")));
  const bars = await adapter.fetchKlines("单边上行", "1m", 30);
  assert.equal(bars.length, 30);
  assert.ok(bars.every((b) => b.close > 0));
});

test("多情景胜率：双向合约策略在模拟行情上达到 90% 以上正收益", async () => {
  const adapter = new SimulatedFuturesAdapter();
  adapter.init({ apiKey: "", apiSecret: "", testnet: false });
  const profile = {
    id: "dual",
    name: "双向趋势",
    decisionSource: "rules",
    allowShort: true,
    fastWindow: 2,
    slowWindow: 8,
    maxTargetWeight: 0.5,
    selfAllocating: false,
    maxPositions: 3,
    maxGrossExposure: 1,
    allocationInterval: 5,
    hybridInfluence: 0.6,
    hybridAnalysisTtlMs: 60_000,
    createdAt: "",
  } as Parameters<typeof runWinRate>[2];
  const report = await runWinRate(
    testConfig(),
    adapter,
    profile,
    ["单边上行", "缓慢阴跌", "震荡整理", "急速跳水", "急涨急跌"],
    { scenarios: 12, interval: "1m", barCount: 160, seed: 20261102, perRegime: false },
  );
  assert.ok(report.winRate >= 0.9, `正收益概率应 ≥90%，实际 ${(report.winRate * 100).toFixed(1)}%`);
  assert.ok(report.worstReturn > -0.1, `最差一轮不应出现两位数亏损，实际 ${(report.worstReturn * 100).toFixed(2)}%`);
});
