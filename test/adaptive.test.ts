/** 自适应趋势策略：指标、方向与多情景稳健性。 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildPipeline } from "../src/agents/orchestrator.js";
import type { AppConfig } from "../src/configSchema.js";
import { SimulatedFuturesAdapter } from "./lib/simFutures.js";
import { AdaptiveTrendStrategy, atrOf, efficiencyRatio } from "../src/strategies/adaptiveTrend.js";
import { runBacktest } from "../src/backtest/runner.js";
import { makeBars, testAdapter, testConfig } from "./helpers.js";

function barsOf(closes: number[]) {
  return makeBars(closes);
}

test("自适应趋势：效率比能区分单边与来回折返", () => {
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  const zigzag = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1) * (i % 3));
  assert.ok(efficiencyRatio(up, 32) > 0.95, "单边行情效率比应接近 1");
  assert.ok(efficiencyRatio(zigzag, 32) < 0.4, "来回折返效率比应明显更低");
});

test("自适应趋势：ATR 为正，且随波动放大", () => {
  const calm = atrOf(barsOf(Array.from({ length: 30 }, (_, i) => 100 + i * 0.1)), 14);
  const wild = barsOf(Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 0 : 5) + i * 0.1));
  assert.ok(calm > 0);
  assert.ok(atrOf(wild, 14) > calm, "波动更大的行情 ATR 应更大");
});

test("自适应趋势：上涨做多、下跌在合约中做空、现货不做空", async () => {
  const up = barsOf(Array.from({ length: 90 }, (_, i) => 100 + i * 1.2));
  const down = barsOf(Array.from({ length: 90 }, (_, i) => 240 - i * 1.2));
  const long = await new AdaptiveTrendStrategy(2, 8, 0.5, true).generate({ symbol: "T", bars: up });
  const short = await new AdaptiveTrendStrategy(2, 8, 0.5, true).generate({ symbol: "T", bars: down });
  const spot = await new AdaptiveTrendStrategy(2, 8, 0.5, false).generate({ symbol: "T", bars: down });
  assert.ok(long && long.targetWeight > 0, `上涨应给出多仓，实际 ${long?.targetWeight}`);
  assert.ok(short && short.targetWeight < 0, `下跌合约应给出空仓，实际 ${short?.targetWeight}`);
  assert.equal(spot?.targetWeight, 0, "现货不允许做空");
});

test("自适应趋势：编排层按 engine 选择策略", () => {
  const base = testConfig();
  const cfg = {
    ...base,
    strategy: { ...base.strategy, engine: "adaptive" as const },
  } satisfies AppConfig;
  const pipeline = buildPipeline(cfg, { adapter: testAdapter(), liveTrading: false });
  assert.equal(pipeline.strategy.name, "adaptive-trend");
});

test("自适应趋势：模拟合约上跑通完整回测（多情景胜率机制已随模拟交易所下线）", async () => {
  // 原「多情景胜率 ≥90%」用例依赖 runWinRate + 模拟行情——该机制已按
  // 「一切以实盘数据为准」下线。保留等价价值的部分：自适应引擎在合约
  // 记账（保证金/做空）下能走完整条回测流水线并产出指标。
  const adapter = new SimulatedFuturesAdapter();
  adapter.init({ apiKey: "", apiSecret: "", testnet: false });
  const base = testConfig();
  const result = await runBacktest(
    { ...base, strategy: { ...base.strategy, engine: "adaptive" } },
    adapter,
    {
      id: "adaptive",
      name: "自适应趋势",
      decisionSource: "rules",
      engine: "adaptive",
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
    } as Parameters<typeof runBacktest>[2],
    { symbols: ["单边上行", "缓慢阴跌", "震荡整理", "急速跳水", "急涨急跌"], interval: "1m", barCount: 200, strategyId: "adaptive" },
  );
  assert.ok(result.metrics, "自适应策略在合约记账下应产出回测指标");
  assert.ok(result.equityCurve.length > 0, "应有权益曲线");
});
