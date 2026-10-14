/**
 * 因子库：把「一个双均线」升级成可组合、可解释的多因子横截面选股。
 *
 * 每个因子只回答一个问题，输出一个无量纲分数（越高越看好）：
 *   trend      趋势方向与强度（快慢均线 + 上涨根数占比）
 *   momentum   中期动量（近 N 根累计收益，波动率调整后）
 *   breakout   突破位置（相对近 N 根最高/最低）
 *   reversal   短期超跌反弹（z-score 取负）
 *   volume     量价配合（OBV 斜率归一）
 *
 * 关键设计：
 * - 因子分数**只在候选池内做横截面标准化**（z-score），避免不同标的量纲不可比；
 * - 权重之和自动归一，允许用户只挑自己信的两个因子；
 * - 每个因子都能在 UI 上单独开关与调权，出问题时能定位到是谁带偏的。
 */

import { getLogger } from "../core/logger.js";
import { FACTOR_META, type FactorMeta, type FactorName } from "./meta.js";

const log = getLogger("factors");

export type { FactorName, FactorMeta } from "./meta.js";

export interface FactorInput {
  symbol: string;
  bars: { timestamp: Date; open: number; high: number; low: number; close: number; volume: number }[];
}

export interface FactorSpec extends FactorMeta {
  compute(input: FactorInput): number;
}

export const FACTORS: FactorSpec[] = FACTOR_META.map((meta) => ({
  ...meta,
  compute: (input) => IMPL[meta.name](input),
}));

/** 各因子的计算实现（与 meta 一一对应）。 */
const IMPL: Record<FactorName, (input: FactorInput) => number> = {
  trend: ({ bars }) => {
    const closes = bars.map((b) => b.close);
    if (closes.length < 21) return 0;
    const fast = mean(closes.slice(-5));
    const slow = mean(closes.slice(-20));
    if (slow <= 0) return 0;
    const maGap = (fast - slow) / slow;
    const recent = bars.slice(-20);
    const upRatio = recent.filter((b) => b.close >= b.open).length / recent.length;
    return maGap * 2 + (upRatio - 0.5) * 0.4;
  },

  momentum: ({ bars }) => {
    const closes = bars.map((b) => b.close);
    if (closes.length < 21) return 0;
    const from = closes[closes.length - 21]!;
    const to = closes[closes.length - 1]!;
    if (from <= 0) return 0;
    const ret = (to - from) / from;
    const vol = std(closes.slice(-21));
    if (vol <= 0) return ret;
    return ret / (vol * Math.sqrt(21));
  },

  breakout: ({ bars }) => {
    if (bars.length < 20) return 0;
    const window = bars.slice(-60);
    const close = window[window.length - 1]!.close;
    const hi = Math.max(...window.map((b) => b.high));
    const lo = Math.min(...window.map((b) => b.low));
    if (!(hi > lo)) return 0;
    return ((close - lo) / (hi - lo)) * 2 - 1;
  },

  reversal: ({ bars }) => {
    const closes = bars.map((b) => b.close);
    if (closes.length < 21) return 0;
    const base = mean(closes.slice(-20));
    const sd = std(closes.slice(-20));
    if (sd <= 0) return 0;
    return -(mean(closes.slice(-5)) - base) / sd;
  },

  volume: ({ bars }) => {
    if (bars.length < 21) return 0;
    const window = bars.slice(-20);
    let obv = 0;
    for (let i = 1; i < window.length; i++) {
      const prev = window[i - 1]!;
      const cur = window[i]!;
      if (cur.close > prev.close) obv += cur.volume;
      else if (cur.close < prev.close) obv -= cur.volume;
    }
    const totalVol = window.reduce((a, b) => a + b.volume, 0) || 1;
    const priceMove = (window[window.length - 1]!.close - window[0]!.close) / window[0]!.close;
    const obvSlope = obv / totalVol;
    return obvSlope * priceMove >= 0 ? obvSlope * Math.min(1, Math.abs(priceMove) * 20) : obvSlope * 0.2;
  },
};



export interface FactorConfig {
  /** 启用的因子及权重 */
  weights: Record<string, number>;
}

export interface ScoredSymbol {
  symbol: string;
  /** 综合分（横截面 z-score 加权） */
  score: number;
  /** 各因子的原始分，便于排查 */
  raw: Record<FactorName, number>;
  /** 各因子对总分的贡献 */
  contributions: Record<FactorName, number>;
  /** 参与打分的因子 */
  factors: FactorName[];
}

/** 综合打分：横截面标准化 + 加权。 */
export function scoreFactors(
  inputs: FactorInput[],
  config: FactorConfig,
): ScoredSymbol[] {
  const active = FACTORS.filter((f) => (config.weights[f.name] ?? 0) !== 0);
  if (inputs.length === 0 || active.length === 0) return [];

  // 每个因子先在池内做 z-score 标准化，消除量纲差异
  const raw: Record<FactorName, number>[] = inputs.map((input) => {
    const row = {} as Record<FactorName, number>;
    for (const f of FACTORS) {
      try {
        row[f.name] = Number.isFinite(f.compute(input)) ? f.compute(input) : 0;
      } catch (err) {
        log.debug("因子 %s 计算失败（%s）: %s", f.name, input.symbol, (err as Error).message);
        row[f.name] = 0;
      }
    }
    return row;
  });

  // 每个因子在池内做 z-score：zByFactor[因子][标的序号]
  const zByFactor: Record<string, number[]> = {};
  for (const factor of FACTORS) {
    const values = raw.map((r) => r[factor.name]);
    const mu = mean(values);
    const sd = std(values);
    zByFactor[factor.name] = values.map((v) => (sd > 1e-12 ? (v - mu) / sd : 0));
  }

  const weights = active.map((f) => config.weights[f.name] ?? 0);
  const weightSum = weights.reduce((a, b) => a + Math.abs(b), 0) || 1;

  return inputs
    .map((input, i) => {
      const contributions = {} as Record<FactorName, number>;
      let score = 0;
      for (const factor of FACTORS) {
        const w = config.weights[factor.name] ?? 0;
        const z = zByFactor[factor.name]?.[i] ?? 0;
        contributions[factor.name] = Number(((w / weightSum) * z).toFixed(6));
        if (w !== 0) score += (w / weightSum) * z;
      }
      return {
        symbol: input.symbol,
        score: Number(score.toFixed(6)),
        raw: raw[i]!,
        contributions,
        factors: active.map((f) => f.name),
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** 默认因子配置。 */
export function defaultFactorConfig(): FactorConfig {
  const weights: Record<string, number> = {};
  for (const f of FACTORS) weights[f.name] = f.defaultWeight;
  return { weights };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const mu = mean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - mu) ** 2, 0) / (values.length - 1));
}