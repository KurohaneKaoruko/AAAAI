/**
 * 组合优化：把「按分数给权重」升级为「考虑相关性与波动的权重」。
 *
 * 两个方法，都不需要外部求解器、可解释、可单测：
 *
 * 1) HRP（Hierarchical Risk Parity，分层风险平价）
 *    相关性聚类 -> 递归二分 -> 簇内按 1/σ 分配 -> 簇间按 1/簇波动分配。
 *    相比均值方差，HRP 对协方差估计误差稳健得多（样本越少越该用它），
 *    这是 L��pez de Prado 在均值方差失效场景下的标准替代。
 *
 * 2) 波动率目标（Vol Targeting）
 *    把组合整体波动率拉到目标值：高波动的标的自动减仓。
 *    叠加在 1) 的结果上，并受单标的/总仓位上限约束。
 *
 * 用法上有一个原则：**AI 自主配置模式下不覆盖模型的判断**，
 * 这两层只作用于规则路径（以及显式开启时的配置器），否则就成了"系统跟模型打架"。
 */

import { getLogger } from "../core/logger.js";

const log = getLogger("portfolio:opt");

export interface CovInput {
  symbol: string;
  /** 按时间对齐的收益序列（长度一致） */
  returns: number[][];
}

/** 年化协方差矩阵（对角线是方差）。 */
export function covarianceMatrix(symbols: string[], returns: number[][], periodsPerYear = 252): number[][] {
  const n = symbols.length;
  const cov: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const mean = returns.map((r) => (r.length ? r.reduce((a, b) => a + b, 0) / r.length : 0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      const ri = returns[i] ?? [];
      const rj = returns[j] ?? [];
      const len = Math.min(ri.length, rj.length);
      for (let k = 0; k < len; k++) {
        s += (ri[k]! - mean[i]!) * (rj[k]! - mean[j]!);
      }
      const v = len > 1 ? (s / (len - 1)) * periodsPerYear : 0;
      cov[i]![j] = v;
      cov[j]![i] = v;
    }
  }
  return cov;
}

/** 相关性矩阵（从协方差导出，零方差对强制相关=0）。 */
export function correlationMatrix(cov: number[][]): number[][] {
  const n = cov.length;
  const corr: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const sd = cov.map((row, i) => Math.sqrt(Math.max(0, row[i]!)));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const denom = sd[i]! * sd[j]!;
      corr[i]![j] = denom > 1e-12 ? cov[i]![j]! / denom : 0;
    }
  }
  return corr;
}

export interface OptimizeConstraints {
  /** 单标的上限 */
  maxPositionWeight: number;
  /** 组合总仓位上限 */
  grossCap: number;
  /** 至少保留几个标的（0 = 不限制） */
  minPositions?: number;
}

/**
 * HRP 权重。
 * 单资产时应为 1（无分散化可言）；两资产时应约等于 1/σ 比例 —— 测试就锁这一点。
 */
export function riskParityWeights(
  symbols: string[],
  returns: number[][],
  constraints: OptimizeConstraints,
  periodsPerYear = 252,
): Record<string, number> {
  const n = symbols.length;
  if (n === 0) return {};
  if (n === 1) return { [symbols[0]!]: 1 };

  const cov = covarianceMatrix(symbols, returns, periodsPerYear);
  const corr = correlationMatrix(cov);

  // 1) 聚类距离 d = sqrt(0.5 * (1 - ρ))
  const dist: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      dist[i]![j] = i === j ? 0 : Math.sqrt(Math.max(0, 0.5 * (1 - corr[i]![j]!)));
    }
  }

  // 2) 层次聚类 -> 准对角顺序，3) 按簇方差递归分配（簇权重 ∝ 1/簇方差）
  const order = quadiag(dist)[0] ?? symbols.map((_, i) => i);
  const byIndex = allocateCluster(cov, order);
  const out: Record<string, number> = {};
  for (let i = 0; i < symbols.length; i++) {
    const w = byIndex[i] ?? 0;
    if (w > 0) out[symbols[i]!] = w;
  }
  log.debug("HRP 权重: %s", JSON.stringify(out));
  return applyConstraints(out, constraints);
}

/** 准对角化后的簇序列（最后一项是全部资产的顺序）。 */
function quadiag(dist: number[][]): number[][] {
  const n = dist.length;
  const active: number[][] = Array.from({ length: n }, (_, i) => [i]);
  while (active.length > 1) {
    let best = Infinity;
    let bi = 0;
    let bj = 1;
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const d = clusterDistance(dist, active[i]!, active[j]!);
        if (d < best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    }
    const merged = [...active[bi]!, ...active[bj]!];
    active.splice(bj, 1);
    active.splice(bi, 1);
    active.push(merged);
  }
  return active;
}

function clusterDistance(dist: number[][], a: number[], b: number[]): number {
  let s = 0;
  for (const i of a) for (const j of b) s += dist[i]![j]!;
  return s / (a.length * b.length);
}

/**
 * 递归二分分配权重，返回「和为 1」的权重表。
 *
 * 标准 HRP 的关键：子簇先**内部归一化**，再按 1/子簇方差 分配簇权重。
 * 若不先归一化，方差会被重复计入（两个资产时权重会退化成 1 : 1/n²）。
 */
function allocateCluster(cov: number[][], indices: number[]): Record<number, number> {
  if (indices.length === 1) return { [indices[0]!]: 1 };
  const mid = Math.max(1, Math.floor(indices.length / 2));
  const left = indices.slice(0, mid);
  const right = indices.slice(mid);
  const l = allocateCluster(cov, left);
  const r = allocateCluster(cov, right);
  const lv = clusterVariance(cov, left);
  const rv = clusterVariance(cov, right);
  const total = lv + rv;
  const lw = total > 0 ? rv / total : 0.5;
  const rw = total > 0 ? lv / total : 0.5;
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(l)) out[Number(k)] = v * lw;
  for (const [k, v] of Object.entries(r)) out[Number(k)] = v * rw;
  return out;
}

function clusterVariance(cov: number[][], indices: number[]): number {
  let v = 0;
  for (const i of indices) for (const j of indices) v += cov[i]![j]!;
  return v;
}

export interface VolTargetOptions extends OptimizeConstraints {
  /** 目标年化波动率（如 0.15 = 15%） */
  targetVol: number;
  /** 杠杆上限（无杠杆产品保持 1） */
  maxLeverage?: number;
}

/** 组合年化波动率（给定权重与收益序列）。 */
export function portfolioVolatility(
  weights: Record<string, number>,
  returns: number[][],
  periodsPerYear = 252,
): number {
  const symbols = Object.keys(weights).filter((s) => (weights[s] ?? 0) > 0);
  if (symbols.length === 0) return 0;
  const cov = covarianceMatrix(symbols, returns, periodsPerYear);
  let v = 0;
  symbols.forEach((s, i) => {
    symbols.forEach((t, j) => {
      v += (weights[s] ?? 0) * (weights[t] ?? 0) * cov[i]![j]!;
    });
  });
  return Math.sqrt(Math.max(0, v));
}

/**
 * 波动率目标：把组合整体波动率缩放到目标值，再过一遍约束。
 * 只改整体敞口，不改相对权重。
 */
export function applyVolTarget(
  weights: Record<string, number>,
  returns: number[][],
  options: VolTargetOptions,
  periodsPerYear = 252,
): Record<string, number> {
  const symbols = Object.keys(weights).filter((s) => (weights[s] ?? 0) > 0);
  if (symbols.length === 0) return {};
  const currentVol = portfolioVolatility(weights, returns, periodsPerYear);
  if (!(currentVol > 0)) return applyConstraints(weights, options);
  const scale = Math.min(options.targetVol / currentVol, options.maxLeverage ?? 1);
  const scaled: Record<string, number> = {};
  for (const s of symbols) scaled[s] = (weights[s] ?? 0) * scale;
  log.debug("波动率目标：当前 %.2f%% -> 缩放系数 %.2f", currentVol * 100, scale);
  return applyConstraints(scaled, options);
}

/** 约束：单标的上限、总仓位上限；可选保留至少 N 个标的。 */
export function applyConstraints(
  weights: Record<string, number>,
  constraints: OptimizeConstraints,
): Record<string, number> {
  const entries = Object.entries(weights)
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1]);

  let capped: [string, number][] = [];
  for (const [s, w] of entries) {
    const c = Math.min(w, constraints.maxPositionWeight);
    if (c > 0) capped.push([s, c]);
  }
  // 总仓位压缩（按比例）
  let sum = capped.reduce((a, [, w]) => a + w, 0);
  if (sum > constraints.grossCap && sum > 0) {
    const k = constraints.grossCap / sum;
    capped = capped.map(([s, w]) => [s, w * k]);
    sum = constraints.grossCap;
  }
  // 最小持仓数：不足时从权重最高的补
  const min = constraints.minPositions ?? 0;
  if (min > 0 && capped.length < min) {
    const all = entries.slice(0, min);
    capped = all.map(([s, w]) => [s, w]);
    const s2 = capped.reduce((a, [, w]) => a + w, 0);
    const k = Math.min(1, constraints.grossCap / (s2 || 1));
    capped = capped.map(([s, w]) => [s, w * k]);
  }
  const out: Record<string, number> = {};
  for (const [s, w] of capped) out[s] = Number(w.toFixed(6));
  return out;
}

function equalWithin(symbols: string[], constraints: OptimizeConstraints): Record<string, number> {
  const w = Math.min(constraints.maxPositionWeight, constraints.grossCap / Math.max(1, symbols.length));
  const out: Record<string, number> = {};
  for (const s of symbols) if (w > 0) out[s] = Number(w.toFixed(6));
  return out;
}