/**
 * Ledoit-Wolf 收缩协方差（2004）。
 *
 * 为什么需要：样本协方差 S 在 n 接近 p 时几乎是随机矩阵，正则性极差
 * （几乎必然出现虚高/虚低的"相关性"），均值方差与 HRP 都建在它之上，
 * 于是优化结果全在拟合噪声。收缩把 S 朝一个结构化的目标 F 拉，
 * 强度由数据自己估计：
 *
 *   λ* = (π̂ - γ̂) / Δ̂,  clip 到 [0,1]
 *     π̂ = (1/n)Σ_t ‖x_t x_t' - S‖²_F   （样本协方差自身的估计误差）
 *     γ̂ = ‖S - F‖²_F                  （样本协方差偏离目标的程度）
 *     Δ̂ = (1/n)Σ_t ‖x_t x_t' - F‖²_F   （目标偏离真实总体协方差的程度）
 *
 * 目标 F 有三种：
 * - diagonal（默认，本项目采用）：**保住每个标的自己的样本方差，只把相关系数拉向 0**。
 *   方差是 n 个观测就能估得比较准的信息，而成对相关性在样本少时几乎全是噪声 ——
 *   所以只收缩后者。这样既提升稳定性，又不会把"波动大/小"的真实差异抹平。
 * - identity（Ledoit-Wolf 原始目标）：F = μ·I，方差也一起拉向平均值。更保守，但会损失方差信息。
 * - constant_correlation：保方差、把相关系数拉向全体平均。适合你知道存在共同因子时。
 *   注意：p=2 时它退化成样本协方差本身（收缩为空操作）。
 *
 * 收益：估计误差下降、协方差矩阵一定正定（样本协方差可能奇异）。
 */

import { getLogger } from "../core/logger.js";

const log = getLogger("portfolio:lw");

export type ShrinkageTarget = "diagonal" | "identity" | "constant_correlation";

export interface ShrinkageResult {
  /** 收缩后的协方差矩阵 */
  covariance: number[][];
  /** 收缩强度 λ ∈ [0,1]（0 = 不收缩，1 = 完全用目标） */
  intensity: number;
  /** 目标矩阵 F（便于展示/调试） */
  target: number[][];
}

/** 外积 + Frobenius 范数平方 */
function frobSq(a: number[][]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < a.length; j++) s += (a[i]![j] ?? 0) ** 2;
  return s;
}

function sub(a: number[][], b: number[][]): number[][] {
  return a.map((row, i) => row.map((v, j) => v - b[i]![j]!));
}

/**
 * 对「每行一个观测」的矩阵做 Ledoit-Wolf 收缩。
 * observations: n 行 × p 列（行=时间，列=变量）。少于 2 行时退回样本协方差。
 */
export function ledoitWolf(observations: number[][], targetKind: ShrinkageTarget = "diagonal"): ShrinkageResult {
  const n = observations.length;
  const dim = observations[0]?.length ?? 0;
  if (n === 0 || dim === 0) return { covariance: [], intensity: 0, target: [] };
  if (n < 3) {
    const cov = sampleCovariance(observations);
    return { covariance: cov, intensity: 0, target: cov };
  }

  const S = sampleCovariance(observations);
  const F =
    targetKind === "identity"
      ? identityTarget(S)
      : targetKind === "constant_correlation"
        ? constantCorrelationTarget(S)
        : diagonalTarget(S);
  const mean = columnMeans(observations);

  // π̂ = 样本协方差自身的估计误差（用每个观测的外积相对均值的偏离衡量）：
  //   π̂ = (1/n) Σ_t ‖y_t y_t' - S‖²_F
  // 目标偏差 θ_F = ‖M - F‖²_F（M 为二阶矩矩阵），代表"把真实结构换成目标结构"的代价。
  const M = Array.from({ length: dim }, () => new Array(dim).fill(0));
  for (let t = 0; t < n; t++) {
    const y = observations[t]!.map((v, j) => v - mean[j]!);
    for (let i = 0; i < dim; i++) {
      const yi = y[i]!;
      for (let j = 0; j < dim; j++) M[i]![j]! += yi * y[j]!;
    }
  }
  for (let i = 0; i < dim; i++) for (let j = 0; j < dim; j++) M[i]![j]! /= n;

  let dispersion = 0;
  for (let t = 0; t < n; t++) {
    const y = observations[t]!.map((v, j) => v - mean[j]!);
    const outer = outerSq(y);
    dispersion += outer - 2 * quadForm(y, S) + frobSq(S);
  }
  dispersion /= n;
  // 样本协方差的估计误差按 1/n 衰减（Var(S_ij) ≈ Var(y_i y_j)/n），
  // 必须再除一次 n；否则 π̂ 不随样本量下降，收缩强度会永远停在同一个值。
  const pi = dispersion / n;
  const thetaF = frobSq(sub(M, F));

  // 强度：把估计误差与目标偏差按 Stein 意义比较
  //   λ* = π̂ / (π̂ + θ_F)
  // 行为自洽：
  //   - 数据越少 → π̂ 越大 → λ→1（不信样本，全信目标）；
  //   - 目标与真实结构一致（如互不相关）→ θ_F→0 → λ→1（正好抹掉虚假相关性）；
  //   - 目标有偏且样本充足 → π̂→0 → λ→0（保留真实相关性）。
  const denominator = pi + thetaF;
  const intensity = denominator > 1e-24 ? Math.min(1, Math.max(0, pi / denominator)) : 0;

  const covariance = S.map((row, i) => row.map((v, j) => (1 - intensity) * v + intensity * F[i]![j]!));
  log.debug("Ledoit-Wolf：λ=%s（n=%d, dim=%d, π̂=%s, θF=%s）", intensity.toFixed(4), n, dim, pi.toExponential(2), thetaF.toExponential(2));
  return { covariance, intensity, target: F };
}

/** 列均值。 */
function columnMeans(observations: number[][]): number[] {
  const dim = observations[0]?.length ?? 0;
  const mean = new Array(dim).fill(0);
  for (const row of observations) for (let j = 0; j < dim; j++) mean[j] += row[j]!;
  for (let j = 0; j < dim; j++) mean[j]! /= observations.length;
  return mean;
}

function sampleCovariance(observations: number[][]): number[][] {
  const n = observations.length;
  const dim = observations[0]!.length;
  const mean = columnMeans(observations);
  const denom = n - 1 > 0 ? n - 1 : n;

  const cov = Array.from({ length: dim }, () => new Array(dim).fill(0));
  for (const row of observations) {
    for (let i = 0; i < dim; i++) {
      const di = row[i]! - mean[i]!;
      for (let j = i; j < dim; j++) {
        const dj = row[j]! - mean[j]!;
        cov[i]![j]! += di * dj;
        // 只在对角线以下做镜像：i===j 时再镜像一次会让所有方差翻倍
        if (j > i) cov[j]![i]! += di * dj;
      }
    }
  }
  for (let i = 0; i < dim; i++) for (let j = 0; j < dim; j++) cov[i]![j]! /= denom;
  return cov;
}

/** 对角目标：保留样本方差，相关系数全部拉向 0（默认）。 */
function diagonalTarget(S: number[][]): number[][] {
  return S.map((row, i) => row.map((_, j) => (i === j ? S[i]![i]! : 0)));
}

/** 恒等目标：F = μ·I（μ 为样本方差均值），即方差与相关系数都拉向均值。 */
function identityTarget(S: number[][]): number[][] {
  const p = S.length;
  const mu = S.reduce((acc, row, i) => acc + row[i]!, 0) / p;
  return S.map((_, i) => S.map((__, j) => (i === j ? mu : 0)));
}

/** 常数相关性目标：方差取样本方差，相关系数取全体平均。 */
function constantCorrelationTarget(S: number[][]): number[][] {
  const p = S.length;
  const sd = S.map((row, i) => Math.sqrt(Math.max(0, row[i]!)));
  const corrs: number[] = [];
  for (let i = 0; i < p; i++) {
    for (let j = i + 1; j < p; j++) {
      const denom = sd[i]! * sd[j]!;
      if (denom > 1e-12) corrs.push(S[i]![j]! / denom);
    }
  }
  const avgCorr = corrs.length > 0 ? corrs.reduce((a, b) => a + b, 0) / corrs.length : 0;
  return S.map((row, i) => row.map((_, j) => (i === j ? S[i]![j]! : avgCorr * sd[i]! * sd[j]!)));
}

function outerSq(x: number[]): number {
  let s = 0;
  for (const v of x) s += v * v;
  return s * s;
}

function quadForm(x: number[], M: number[][]): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) for (let j = 0; j < x.length; j++) s += x[i]! * M[i]![j]! * x[j]!;
  return s;
}

/** 便捷：把「按标的的收益序列」转成行=时间的观测矩阵后做收缩。 */
export function shrinkReturns(returns: number[][], targetKind: ShrinkageTarget = "diagonal"): ShrinkageResult {
  const n = Math.min(...returns.map((r) => r.length));
  const observations: number[][] = [];
  for (let t = 0; t < n; t++) observations.push(returns.map((r) => r[t] ?? 0));
  return ledoitWolf(observations, targetKind);
}

/** 矩阵是否正定（Cholesky 可分解 + 主元为正）。 */
export function isPositiveDefinite(M: number[][]): boolean {
  const p = M.length;
  const L = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = M[i]![j]!;
      for (let k = 0; k < j; k++) sum -= L[i]![k]! * L[j]![k]!;
      if (i === j) {
        if (sum <= 1e-12) return false;
        L[i]![j] = Math.sqrt(sum);
      } else {
        L[i]![j] = sum / L[j]![j]!;
      }
    }
  }
  return true;
}