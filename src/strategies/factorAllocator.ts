/**
 * 因子驱动的横截面配置器：替代"人人等权"。
 *
 * 与 AI 配置器并存，但有一条明确边界：
 * - 纯规则模式：因子分直接决定权重（可选再用 HRP + 波动率目标修正）；
 * - AI 自主配置（chat / systemone / hybrid）：**不覆盖模型的判断**，
 *   只在模型给出权重后做"风险平价倾斜 + 波动率目标"这类风险层面的修正，
 *   并且在事件里注明做过优化，方便核对。
 */

import { getLogger } from "../core/logger.js";
import { scoreFactors, type FactorConfig, type FactorInput } from "../factors/index.js";
import {
  applyConstraints,
  applyVolTarget,
  portfolioVolatility,
  riskParityWeights,
  type OptimizeConstraints,
} from "../portfolio/optimizer.js";
import { returnsOf } from "../data/returns.js";
import type { AllocationResult } from "./allocator.js";

const log = getLogger("optimizer");

export interface OptimizeSettings {
  method: "none" | "score" | "risk_parity";
  factorWeights: Record<string, number>;
  targetVol: number;
  minPositions: number;
  /** 协方差估计方式（HRP / 波动率目标用） */
  covariance: "sample" | "lw";
}

export interface ScoreAllocationOptions {
  limits: OptimizeConstraints;
  optimize: OptimizeSettings;
  /** 组合总仓位上限 */
  grossCap: number;
  /**
   * 当前持仓权重（symbol -> 权重，0/缺省 = 未持有）。
   * 用于「领先优势不足时沿用现有持仓」，避免横截面排名抖动导致反复换仓。
   */
  currentWeights?: Record<string, number>;
  /**
   * 时序动量过滤的回看窗口（通常传策略 slowWindow）。
   * 横截面 z-score 只回答「谁相对更好」；全池下跌时仍有一半为正分，
   * 纯横截面会永远满仓做多。叠加绝对动量过滤后，全池走弱就空仓。
   */
  slowWindow?: number;
}

/** 领先优势门槛（标准差单位）：第一名领先不足此值时不算「明确领先」。 */
const LEAD_EDGE = 0.5;

const DEFAULT_FACTORS: FactorConfig = {
  weights: { trend: 1, momentum: 1, breakout: 0.6, reversal: 0, volume: 0.4 },
};

/**
 * 规则路径：按因子分从高到低分配权重。
 * 分数转权重用「相对强度 + 软截断」：领先的标的拿更多，但不会赢家通吃。
 */
export function allocateByFactors(
  inputs: FactorInput[],
  options: ScoreAllocationOptions,
): { result: AllocationResult; scored: ReturnType<typeof scoreFactors> } {
  const factorConfig: FactorConfig =
    Object.keys(options.optimize.factorWeights).length > 0
      ? { weights: options.optimize.factorWeights }
      : DEFAULT_FACTORS;

  const scored = scoreFactors(inputs, factorConfig);
  /**
   * 领先优势门槛：第一名领先第二名不足 LEAD_EDGE 个标准差，且现任领先者
   * 仍在正分池里 → 沿用现任领先者，不换仓。
   *
   * 横截面排名的摩擦全在换仓：领先者在 BTC/ETH 之间来回换，每次换仓是
   * 「平旧领先 + 买新领先」两笔全额单。真实行情里两个高度相关标的的因子分
   * 差本来就小且抖，没有优势门槛的排名就是噪声放大器。只有现任领先者
   * **掉出正分池**或被明显反超（≥ LEAD_EDGE）才交棒。
   */
  /*
   * 绝对动量过滤（时序动量 + 横截面动量的组合，Moskowitz/Ooi/Pedersen）：
   * z-score 是池内相对排名，哪怕所有标的都在跌，也总有一半是正分；
   * 没有这层过滤，配置器在全面下跌里仍会满仓做多。
   */
  const lookback = Math.max(2, options.slowWindow ?? 48);
  const absoluteMomentum = (symbol: string): number => {
    const bars = inputs.find((i) => i.symbol === symbol)?.bars ?? [];
    if (bars.length < lookback + 1) return 1; // 数据不足时不额外限制（因子自身会处理）
    const past = bars[bars.length - 1 - lookback]!.close;
    const now = bars[bars.length - 1]!.close;
    return past > 0 && Number.isFinite(now) ? now / past - 1 : 0;
  };
  const positive = scored.filter((s) => s.score > 0 && absoluteMomentum(s.symbol) > 0);
  const incumbent = Object.entries(options.currentWeights ?? {})
    .filter(([, w]) => w > 0.01)
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  let pool = positive;
  if (pool.length === 0) {
    // 全池都没有「相对为正 + 绝对动量为正」的标的：持币观望。
    return {
      result: {
        weights: {},
        cashWeight: 1,
        confidence: 0.5,
        reason: `无正分标的（${lookback} 根绝对动量过滤后），保持空仓`,
        source: "rules",
        notes: [],
      },
      scored,
    };
  }
  if (
    incumbent &&
    positive.length > 1 &&
    pool.some((s) => s.symbol === incumbent) &&
    Math.abs(pool[0]!.score - (pool.find((s) => s.symbol === incumbent)?.score ?? 0)) < LEAD_EDGE
  ) {
    // 优势不足：把现任领先者顶到池首，权重计算自然延续现有持仓格局
    pool = [pool.find((s) => s.symbol === incumbent)!, ...pool.filter((s) => s.symbol !== incumbent)];
  }

  // 分数 -> 权重：以池内最高分为 1，其余按比例；再过额度裁剪
  const top = pool[0]?.score ?? 1;
  const raw: Record<string, number> = {};
  for (const s of pool) {
    raw[s.symbol] = top > 0 ? Math.max(0, s.score / top) : 0;
  }

  let weights = applyConstraints(raw, {
    maxPositionWeight: options.limits.maxPositionWeight,
    grossCap: options.grossCap,
    minPositions: options.optimize.minPositions,
  });

  /**
   * 权重量化：按 0.1 一档取整。
   *
   * 因子分每轮都在动，连续权重意味着每次决策都产生几厘米的仓位差 ——
   * 0.357 → 0.341 也值得下一笔单吗？量化后权重只在档位间跳，
   * 分数的小幅漂移不再触发交易；真正的排名变化（跨档）才调仓。
   * 与风控侧的再平衡死区（漂移 < 5 个百分点不动）配合，横截面换手
   * 从「每轮都动」降到「排名/档位真的变了才动」。
   */
  for (const [symbol, w] of Object.entries(weights)) {
    weights[symbol] = Math.round(w * 10) / 10;
  }

  // 风险平价修正：只在显式选择时启用，它会改写相对权重
  if (options.optimize.method === "risk_parity" && Object.keys(weights).length > 1) {
    const symbols = Object.keys(weights);
    const returns = symbols.map((s) => returnsOf(inputs.find((i) => i.symbol === s)!.bars));
    const rp = riskParityWeights(
      symbols,
      returns,
      {
        maxPositionWeight: options.limits.maxPositionWeight,
        grossCap: options.grossCap,
        minPositions: options.optimize.minPositions,
      },
      252,
      options.optimize.covariance,
    );
    if (Object.keys(rp).length > 0) weights = rp;
  }

  weights = maybeVolTarget(weights, inputs, options);

  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  const leader = pool[0];
  return {
    result: {
      weights,
      cashWeight: Number(Math.max(0, 1 - sum).toFixed(6)),
      confidence: 0.5,
      reason: leader
        ? `因子：${leader.factors.map((f) => f).join("+")}，领先 ${leader.symbol}（分 ${leader.score.toFixed(2)}）`
        : "无有效因子分",
      source: "rules",
      notes: [],
    },
    scored,
  };
}

/**
 * 对已有权重做风险层面修正（波动率目标）。
 * 用于 AI 配置：模型定方向，这里只调风险敞口，不改相对偏好（除缩放外）。
 */
export function riskTiltWeights(
  weights: Record<string, number>,
  inputs: FactorInput[],
  settings: OptimizeSettings,
  limits: OptimizeConstraints,
  grossCap: number,
): Record<string, number> {
  if (settings.method === "none") return weights;
  return maybeVolTarget(weights, inputs, { limits, optimize: settings, grossCap });
}

function maybeVolTarget(
  weights: Record<string, number>,
  inputs: FactorInput[],
  options: ScoreAllocationOptions,
): Record<string, number> {
  const targetVol = options.optimize.targetVol;
  if (!(targetVol > 0) || Object.keys(weights).length === 0) return weights;
  const symbols = Object.keys(weights);
  const returns = symbols.map((s) => {
    const input = inputs.find((i) => i.symbol === s);
    return input ? returnsOf(input.bars) : [];
  });
  const current = portfolioVolatility(weights, returns, 252, options.optimize.covariance);
  const adjusted = applyVolTarget(
    weights,
    returns,
    {
      targetVol,
      maxPositionWeight: options.limits.maxPositionWeight,
      grossCap: options.grossCap,
      minPositions: options.optimize.minPositions,
    },
    252,
    options.optimize.covariance,
  );
  const after = portfolioVolatility(adjusted, returns, 252, options.optimize.covariance);
  log.debug(
    "波动率目标：%s%% -> %s%%（目标 %s%%）",
    (current * 100).toFixed(2),
    (after * 100).toFixed(2),
    (targetVol * 100).toFixed(2),
  );
  return adjusted;
}