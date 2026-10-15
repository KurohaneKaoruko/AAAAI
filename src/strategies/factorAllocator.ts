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
}

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
  const positive = scored.filter((s) => s.score > 0);
  const pool = positive.length > 0 ? positive : scored.slice(0, 1);

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
  const leader = scored[0];
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
  log.debug("波动率目标：%.2f%% -> %.2f%%（目标 %.2f%%）", current * 100, after * 100, targetVol * 100);
  return adjusted;
}