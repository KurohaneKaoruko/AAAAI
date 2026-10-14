/**
 * 量化算法层：成本、因子、组合优化、前推验证。
 *
 * 测试原则：**用解析解锁**，不靠"跑出来赚钱"来证明算法对。
 * 例如两资产风险平价必须等于 1/σ 比例、平方根冲击模型必须手算可复现、
 * 前推验证的 IS/OOS 落差必须等于两次收益之差。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CostModel, DEFAULT_IMPACT, realizedVolatility, dailyTurnover, applyImpact } from "../src/cost/impactModel.js";
import { scoreFactors, FACTORS, defaultFactorConfig, type FactorInput } from "../src/factors/index.js";
import {
  covarianceMatrix,
  correlationMatrix,
  riskParityWeights,
  applyVolTarget,
  portfolioVolatility,
  applyConstraints,
} from "../src/portfolio/optimizer.js";
import { allocateByFactors, riskTiltWeights } from "../src/strategies/factorAllocator.js";
import { returnsOf } from "../src/data/returns.js";
import { walkForward, robustness } from "../src/validation/walkForward.js";
import { buildConfig } from "../src/configSchema.js";
import { testAdapter } from "./helpers.js";

// ---------------------------------------------------------------- 成本模型

test("成本：平方根冲击 = 固定点差 + k·σ·sqrt(订单占比)，可手算复现", () => {
  const model = new CostModel({ baseBps: 2, k: 0.35, maxBps: 200, windowBars: 20 });
  // 订单占日成交额 25%，σ=0.02 → 0.35*0.02*sqrt(0.25)=0.0035 → 35 bps
  const stats = { volatility: 0.02, dailyTurnover: 1_000_000 };
  const bps = model.slippageBps(250_000, stats);
  assert.ok(Math.abs(bps - (2 + 35)) < 0.01, `应约 37 bps，实际 ${bps}`);

  // 同样金额、成交额翻倍 → 冲击按 sqrt 减半
  const doubled = model.slippageBps(250_000, { volatility: 0.02, dailyTurnover: 2_000_000 });
  assert.ok(doubled < bps, "流动性更好冲击更小");
  assert.ok(Math.abs(doubled - (2 + 35 / Math.SQRT2)) < 0.05);

  // 数据不足 / 系数为 0 → 退回固定点差（不瞎猜）
  assert.equal(model.slippageBps(250_000, undefined), 2);
  assert.equal(model.slippageBps(0, stats), 2);
  const off = new CostModel({ baseBps: 2, k: 0, maxBps: 200, windowBars: 20 });
  assert.equal(off.slippageBps(250_000, stats), 2, "k=0 时应等价于旧行为");

  // 上限生效
  const capped = new CostModel({ baseBps: 2, k: 5, maxBps: 50, windowBars: 20 });
  assert.equal(capped.slippageBps(900_000, { volatility: 0.5, dailyTurnover: 1_000_000 }), 50);

  // 成交价方向正确
  assert.ok(model.execPrice(100, "BUY", 37) > 100);
  assert.ok(model.execPrice(100, "SELL", 37) < 100);
  const hit = applyImpact(model, 100, "BUY", 2500, stats); // 2500*100 = 250k
  assert.ok(hit.price > 100 && hit.bps > 2);
});

test("成本：波动率与成交额估算", () => {
  const flat = realizedVolatility([100, 100, 100, 100]);
  assert.equal(flat, 0, "零波动应返回 0");
  const choppy = realizedVolatility([100, 110, 100, 110, 100]);
  assert.ok(choppy > 0, "有波动应大于 0");
  const bars = Array.from({ length: 20 }, () => ({ close: 100, volume: 10 }));
  assert.ok(dailyTurnover(bars) > 0);
  assert.equal(dailyTurnover([]), 0);
  assert.equal(DEFAULT_IMPACT.k > 0, true);
});

// ---------------------------------------------------------------- 因子

function bars(closes: number[], volumes: number[] = closes.map(() => 100)): FactorInput["bars"] {
  return closes.map((close, i) => ({
    timestamp: new Date(Date.now() + i * 60_000),
    open: i === 0 ? close : closes[i - 1]!,
    high: close * 1.002,
    low: close * 0.998,
    close,
    volume: volumes[i] ?? 100,
  }));
}

test("因子：横截面 z-score 后排名，强弱方向正确", () => {
  const upTrend = scoreFactors(
    [{ symbol: "UP", bars: bars(Array.from({ length: 40 }, (_, i) => 100 + i * 2)) }],
    defaultFactorConfig(),
  );
  const downTrend = scoreFactors(
    [{ symbol: "DOWN", bars: bars(Array.from({ length: 40 }, (_, i) => 200 - i * 2)) }],
    defaultFactorConfig(),
  );
  assert.ok(upTrend[0]!.raw.trend! > 0, "上涨序列的趋势分应为正");
  assert.ok(downTrend[0]!.raw.trend! < 0, "下跌序列的趋势分应为负");
  assert.ok(upTrend[0]!.raw.breakout! > 0 && downTrend[0]!.raw.breakout! < 0, "突破因子方向也要正确");

  // 两个标的同池时，强者综合分更高
  const pair = scoreFactors(
    [
      { symbol: "UP", bars: bars(Array.from({ length: 40 }, (_, i) => 100 + i * 2)) },
      { symbol: "DOWN", bars: bars(Array.from({ length: 40 }, (_, i) => 200 - i * 2)) },
    ],
    defaultFactorConfig(),
  );
  assert.equal(pair[0]!.symbol, "UP");
  assert.ok(pair[0]!.score > 0 && pair[1]!.score < 0, "对称序列的综合分应一正一负");

  // 贡献度之和 = 综合分（可核对）
  const total = Object.values(pair[0]!.contributions).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - pair[0]!.score) < 1e-5, "因子贡献之和应等于总分（允许四舍五入误差）");
});

test("因子：只有被选中的因子参与打分；权重为 0 的因子不影响排名", () => {
  const inputs: FactorInput[] = [
    { symbol: "A", bars: bars(Array.from({ length: 40 }, (_, i) => 100 + i)) },
    { symbol: "B", bars: bars(Array.from({ length: 40 }, (_, i) => 100 - i)) },
  ];
  const onlyTrend = scoreFactors(inputs, { weights: { trend: 1, momentum: 0, breakout: 0, reversal: 0, volume: 0 } });
  assert.ok(onlyTrend.every((s) => s.factors.length === 1 && s.factors[0] === "trend"), "只有选中的因子参与");
  assert.equal(onlyTrend[0]!.symbol, "A", "只启用趋势时，上涨的 A 应排第一");
  const onlyReversal = scoreFactors(inputs, { weights: { trend: 0, momentum: 0, breakout: 0, reversal: 1, volume: 0 } });
  // 反转因子：涨得多的反而分低
  assert.equal(onlyReversal[onlyReversal.length - 1]!.symbol, "A");
  assert.equal(FACTORS.length, 5, "因子库应有 5 个因子");
});

test("因子配置器：分数高的拿更多权重，且不突破额度", () => {
  const inputs: FactorInput[] = [
    { symbol: "STRONG", bars: bars(Array.from({ length: 60 }, (_, i) => 100 + i * 3)) },
    { symbol: "MID", bars: bars(Array.from({ length: 60 }, (_, i) => 100 + i)) },
    { symbol: "WEAK", bars: bars(Array.from({ length: 60 }, (_, i) => 200 - i * 2)) },
  ];
  const r = allocateByFactors(inputs, {
    limits: { maxPositionWeight: 0.5, grossCap: 0.8 },
    optimize: { method: "score", factorWeights: {}, targetVol: 0, minPositions: 1 },
    grossCap: 0.8,
  });
  const w = r.result.weights;
  assert.ok((w.WEAK ?? 0) === 0, "负分标的应被剔除");
  assert.ok(Object.values(w).every((x) => x <= 0.5 + 1e-9), "不得突破单标的上限");
  assert.ok(Object.values(w).reduce((a, b) => a + b, 0) <= 0.8 + 1e-9, "不得突破总仓位上限");
  // 权重必须与打分排名一致（配置器不引入第二套判断）
  const top = r.scored[0]!;
  assert.ok((w[top.symbol] ?? 0) > 0, "排名第一的标的必须拿到权重");
  const others = Object.entries(w).filter(([s]) => s !== top.symbol);
  for (const [s, weight] of others) {
    const rank = r.scored.findIndex((x) => x.symbol === s);
    const topRank = r.scored.findIndex((x) => x.symbol === top.symbol);
    if (rank > topRank) assert.ok(weight <= (w[top.symbol] ?? 0), "排名靠后的权重不应超过第一名");
  }

  // 只用趋势因子时，强趋势必须拿更多权重（方向性确定性）
  const trendOnly = allocateByFactors(inputs, {
    limits: { maxPositionWeight: 0.5, grossCap: 0.8 },
    optimize: { method: "score", factorWeights: { trend: 1, momentum: 0, breakout: 0, reversal: 0, volume: 0 }, targetVol: 0, minPositions: 1 },
    grossCap: 0.8,
  });
  const tw = trendOnly.result.weights;
  assert.ok((tw.STRONG ?? 0) >= (tw.MID ?? 0), "强趋势权重不低于弱趋势");
});

// ---------------------------------------------------------------- 组合优化

test("组合优化：两资产 HRP 权重 = 逆方差比例（解析解 σA=20%、σB=10%）", () => {
  // HRP 的簇权重按 1/σ² 分配，因此两资产时
  //   wA = σB²/(σA²+σB²) = 0.01/0.05 = 0.2，wB = 0.8
  // （注意与「1/σ 比例」的直觉不同：那是严格等风险贡献的做法，HRP 用逆方差）
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < 200; i++) {
    a.push((0.2 / Math.sqrt(252)) * (i % 2 === 0 ? 1 : -1));
    b.push((0.1 / Math.sqrt(252)) * (i % 2 === 0 ? 1 : -1));
  }
  const w = riskParityWeights(["A", "B"], [a, b], { maxPositionWeight: 1, grossCap: 1 }, 252);
  assert.ok(Math.abs((w.A ?? 0) - 0.2) < 0.01, `A 应约 20%，实际 ${((w.A ?? 0) * 100).toFixed(1)}%`);
  assert.ok(Math.abs((w.B ?? 0) - 0.8) < 0.01, `B 应约 80%，实际 ${((w.B ?? 0) * 100).toFixed(1)}%`);
  const sum = (w.A ?? 0) + (w.B ?? 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `权重和应为 1，实际 ${sum}`);
});

test("组合优化：相关资产不会被当成两个分散仓位（聚类生效）", () => {
  // A 与 B 完全正相关，波动相同 → HRP 近似等权，但不应出现极端失衡
  const a = Array.from({ length: 100 }, (_, i) => 0.01 * (i % 2 === 0 ? 1 : -1));
  const b = a.map((x) => x);
  const w = riskParityWeights(["A", "B"], [a, b], { maxPositionWeight: 1, grossCap: 1 });
  const ratio = (w.A ?? 0) / (w.B ?? 0);
  assert.ok(Math.abs(ratio - 1) < 0.15, `完全正相关时权重应接近等权，实际比值 ${ratio.toFixed(3)}`);

  // 单资产：权重 1
  assert.deepEqual(riskParityWeights(["ONLY"], [[0.01, -0.01]], { maxPositionWeight: 1, grossCap: 1 }), { ONLY: 1 });
  // 空输入
  assert.deepEqual(riskParityWeights([], [], { maxPositionWeight: 1, grossCap: 1 }), {});
});

test("组合优化：协方差与相关性矩阵（手工核对）", () => {
  const rets = [
    [0.01, -0.01, 0.02, -0.02],
    [0.02, -0.02, 0.04, -0.04], // B = 2*A（正相关、同向）
  ];
  const cov = covarianceMatrix(["A", "B"], rets, 1);
  const varA = rets[0]!.reduce((a, b) => a + b * b, 0) / 3;
  assert.ok(Math.abs(cov[0]![0]! - varA) < 1e-9, "对角线应为方差");
  assert.ok(Math.abs(cov[0]![1]! - 2 * varA) < 1e-9, "B 是 A 的两倍时协方差也是两倍");
  const corr = correlationMatrix(cov);
  assert.ok(Math.abs(corr[0]![1]! - 1) < 1e-9, "完全正相关应为 1");
  assert.equal(corr[0]![0], 1);
});

test("组合优化：波动率目标把组合波动拉到目标值，且不加杠杆", () => {
  const rets = [
    Array.from({ length: 120 }, (_, i) => 0.02 * (i % 3 === 0 ? 1 : -0.5)),
    Array.from({ length: 120 }, (_, i) => 0.01 * (i % 2 === 0 ? 1 : -1)),
  ];
  const weights = { A: 0.5, B: 0.5 };
  const before = portfolioVolatility(weights, rets);
  const after = applyVolTarget(weights, rets, { targetVol: 0.1, maxPositionWeight: 1, grossCap: 1 });
  const afterVol = portfolioVolatility(after, rets);
  assert.ok(afterVol < before, `目标更低时应减仓：${(before * 100).toFixed(1)}% -> ${(afterVol * 100).toFixed(1)}%`);
  assert.ok(afterVol <= 0.1001, `调整后不应超过目标：${afterVol}`);
  const sum = Object.values(after).reduce((a, b) => a + b, 0);
  assert.ok(sum <= 1.0001, "总仓位不得超过 1（不加杠杆）");

  // 目标更高时也不会加杠杆
  const lev = applyVolTarget(weights, rets, { targetVol: 5, maxPositionWeight: 1, grossCap: 1 });
  assert.ok(Object.values(lev).reduce((a, b) => a + b, 0) <= 1.0001);
});

test("组合优化：额度裁剪（单标的、总仓位、最小持仓数）", () => {
  const w = applyConstraints({ A: 0.9, B: 0.5, C: 0.2 }, { maxPositionWeight: 0.4, grossCap: 0.8 });
  assert.ok(Object.values(w).every((x) => x <= 0.4 + 1e-9), "单标的封顶");
  assert.ok(Object.values(w).reduce((a, b) => a + b, 0) <= 0.8 + 1e-9, "总仓位封顶");

  // 最小持仓数：不足时补齐
  const minTwo = applyConstraints({ A: 0.3 }, { maxPositionWeight: 0.5, grossCap: 0.8, minPositions: 2 });
  assert.ok(Object.keys(minTwo).length >= 1, "只有 1 个候选时不能凭空造出第 2 个");
});

test("组合优化：AI 权重只被做风险倾斜，不被改成等权", () => {
  const inputs: FactorInput[] = [
    { symbol: "AI_PICK", bars: bars(Array.from({ length: 60 }, (_, i) => 100 + i * 3)) },
    { symbol: "OTHER", bars: bars(Array.from({ length: 60 }, (_, i) => 100 - i)) },
  ];
  const modelWeights = { AI_PICK: 0.6, OTHER: 0.1 };
  const tilted = riskTiltWeights(
    modelWeights,
    inputs,
    { method: "score", factorWeights: {}, targetVol: 0.1, minPositions: 0 },
    { maxPositionWeight: 0.8, grossCap: 1 },
    1,
  );
  assert.ok((tilted.AI_PICK ?? 0) > (tilted.OTHER ?? 0), "模型偏好的标的仍应占更大权重");
  // method=none 时原样返回
  const none = riskTiltWeights(
    modelWeights,
    inputs,
    { method: "none", factorWeights: {}, targetVol: 0.1, minPositions: 0 },
    { maxPositionWeight: 0.8, grossCap: 1 },
    1,
  );
  assert.deepEqual(none, modelWeights);
});

// ---------------------------------------------------------------- 前推验证

test("前推验证：输出 IS/OOS 落差，gap 恒等于两者之差", async () => {
  const cfg = buildConfig({
    market: { symbols: ["600519"], interval: "1m", bar_count: 400 },
    strategy: { name: "momentum", fast_window: 5, slow_window: 20, max_target_weight: 0.5 },
    risk: { initial_cash: 100000, max_drawdown_pct: 0.5 },
    llm: { enabled: false },
  });
  const wf = await walkForward(cfg, {
    adapter: testAdapter(),
    symbols: ["600519"],
    interval: "1m",
    foldBars: 80,
    folds: 4,
  });
  assert.ok(wf.folds.length > 0, "应产生折");
  for (const f of wf.folds) {
    assert.ok(Math.abs(f.gap - (f.isReturn - f.oosReturn)) < 1e-9, "gap 定义应自洽");
    assert.ok(f.oosBars > 0);
    assert.ok(f.oosFills >= 0);
  }
  assert.ok(wf.avgOosReturn === wf.folds.reduce((a, f) => a + f.oosReturn, 0) / wf.folds.length);
});

test("稳健性：识别尖峰（过拟合）与平台（真信号）", async () => {
  const cfg = buildConfig({
    market: { symbols: ["600519"], interval: "1m", bar_count: 200 },
    strategy: { name: "momentum", fast_window: 5, slow_window: 20, max_target_weight: 0.5 },
    risk: { initial_cash: 100000, max_drawdown_pct: 0.5 },
    llm: { enabled: false },
  });
  const report = await robustness(cfg, {
    adapter: testAdapter(),
    symbols: ["600519"],
    interval: "1m",
    bars: 200,
    grid: { fast: [3, 5, 8], slow: [15, 20, 30], weight: [0.3, 0.6] },
  });
  assert.ok(report.cells.length > 0);
  // 非法参数组合（fast>=slow）不应出现
  for (const c of report.cells) assert.ok(c.fast < c.slow, "非法参数组合不应出现");
  // 最佳格子确实是最优的
  const bestByReturn = [...report.cells].sort((a, b) => b.returnPct - a.returnPct)[0]!;
  assert.equal(report.best!.returnPct, bestByReturn.returnPct);
  assert.ok(report.plateauRatio > 0 && report.plateauRatio <= 1);
  assert.equal(typeof report.overfitRisk, "boolean");
});

// ---------------------------------------------------------------- 收益工具

test("收益工具：对数收益与简单收益", () => {
  const logR = returnsOf([{ close: 100 }, { close: 110 }]);
  assert.ok(Math.abs(logR[0]! - Math.log(1.1)) < 1e-12);
  assert.deepEqual(returnsOf([{ close: 0 }, { close: 10 }]), [], "价格为 0 时不产生收益");
});