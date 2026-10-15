/**
 * Ledoit-Wolf 收缩协方差：用「已知真相」的合成实验验证，而不是看它跑出什么曲线。
 *
 * 判定标准：
 * - 互不相关的真实结构下，收缩应显著降低估计误差（这是收缩存在的理由）；
 * - 真实相关性强时，收缩应很轻、且不破坏真实相关性；
 * - 方差是可信信息，必须原样保留（对角目标）；
 * - 共线数据的样本协方差奇异，收缩后必须正定。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ledoitWolf, shrinkReturns, isPositiveDefinite } from "../src/portfolio/shrinkage.js";
import { covarianceMatrix, riskParityWeights, type CovarianceMethod } from "../src/portfolio/optimizer.js";

/** 可复现的伪随机（固定种子的 LCG + Box-Muller） */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function cholesky(M: number[][]): number[][] {
  const p = M.length;
  const L = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = M[i]![j]!;
      for (let k = 0; k < j; k++) sum -= L[i]![k]! * L[j]![k]!;
      L[i]![j] = i === j ? Math.sqrt(Math.max(0, sum)) : sum / L[j]![j]!;
    }
  }
  return L;
}

/** 从给定协方差抽样（行=时间，列=变量） */
function sampleObservations(cov: number[][], n: number, seed: number): number[][] {
  const L = cholesky(cov);
  const p = cov.length;
  const rand = rng(seed);
  const rows: number[][] = [];
  for (let t = 0; t < n; t++) {
    const z = Array.from({ length: p }, () => {
      const u = Math.max(1e-12, rand());
      const v = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    });
    rows.push(z.map((_, i) => z.slice(0, i + 1).reduce((acc, g, k) => acc + g * L[i]![k]!, 0)));
  }
  return rows;
}

function frobDistance(a: number[][], b: number[][]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < a.length; j++) s += (a[i]![j]! - b[i]![j]!) ** 2;
  return Math.sqrt(s);
}

function meanSquaredError(
  truth: number[][],
  draw: (obs: number[][]) => number[][],
  n: number,
  trials = 25,
): number {
  const symbols = truth.map((_, i) => String(i));
  let sum = 0;
  for (let seed = 1; seed <= trials; seed++) {
    const obs = sampleObservations(truth, n, seed);
    sum += frobDistance(draw(obs), truth) ** 2;
  }
  return sum / trials;
}

/** 观测矩阵（行=时间）转成「按标的的收益序列」（每行一个变量），与真实调用方式一致。 */
function toReturns(obs: number[][]): number[][] {
  const dim = obs[0]?.length ?? 0;
  return Array.from({ length: dim }, (_, j) => obs.map((row) => row[j]!));
}

const sampleEstimator = (obs: number[][]) => {
  const rets = toReturns(obs);
  return covarianceMatrix(rets.map((_, j) => `s${j}`), rets, 1, { method: "sample" });
};
const shrinkEstimator = (obs: number[][]) => {
  const rets = toReturns(obs);
  return covarianceMatrix(rets.map((_, j) => `s${j}`), rets, 1, { method: "lw" });
};

test("收缩：对角线必须原样保留（方差是可信信息）", () => {
  const obs = [
    [1, 2],
    [2, 4],
    [3, 6],
    [4, 8],
  ];
  // 手算：x=[1,2,3,4]（均值 2.5）、y=2x（均值 5）
  //   varA = (2.25+0.25+0.25+2.25)/3 = 1.666667，varB = 4·varA = 6.666667
  const r = ledoitWolf(obs);
  assert.ok(Math.abs(r.target[0]![0]! - 5 / 3) < 1e-9, `对角线应等于样本方差，实际 ${r.target[0]![0]}`);
  assert.ok(Math.abs(r.target[1]![1]! - 20 / 3) < 1e-9, `对角线应等于样本方差，实际 ${r.target[1]![1]}`);
  assert.ok(Math.abs(r.covariance[0]![0]! - r.target[0]![0]!) < 1e-12, "方差必须原样保留");
  assert.ok(Math.abs(r.covariance[1]![1]! - r.target[1]![1]!) < 1e-12, "方差必须原样保留");
});

test("收缩：互不相关的真实结构下，虚假相关性应被抹掉、MSE 明显下降", () => {
  const truth = [
    [0.04, 0],
    [0, 0.01],
  ];
  const raw = meanSquaredError(truth, sampleEstimator, 40);
  const shrunk = meanSquaredError(truth, shrinkEstimator, 40);
  const lambda = ledoitWolf(sampleObservations(truth, 40, 3)).intensity;
  assert.ok(lambda > 0.5, `互不相关数据应大幅收缩，λ=${lambda.toFixed(3)}`);
  assert.ok(
    shrunk < raw * 0.85,
    `MSE 应显著下降：${raw.toExponential(3)} -> ${shrunk.toExponential(3)}`,
  );
});

test("收缩：真实相关性强时收缩很轻、且不破坏真实相关性", () => {
  const truth = [
    [0.04, 0.038],
    [0.038, 0.04],
  ];
  const small = ledoitWolf(sampleObservations(truth, 30, 5)).intensity;
  const large = ledoitWolf(sampleObservations(truth, 2000, 5)).intensity;
  assert.ok(small < 0.3, `强相关时不应重收缩，λ=${small.toFixed(3)}`);
  assert.ok(large < small, `样本越多收缩越轻：${small.toFixed(4)} -> ${large.toFixed(4)}`);

  const shr = ledoitWolf(sampleObservations(truth, 400, 5));
  const rho = shr.covariance[0]![1]! / Math.sqrt(shr.covariance[0]![0]! * shr.covariance[1]![1]!);
  assert.ok(rho > 0.5, `真实相关性应被保留，实际 rho=${rho.toFixed(3)}`);
});

test("收缩：中等相关 + 小样本时不应明显恶化（保守可用）", () => {
  const truth = [
    [0.04, 0.012, 0.004],
    [0.012, 0.01, 0.003],
    [0.004, 0.003, 0.0225],
  ];
  const raw = meanSquaredError(truth, sampleEstimator, 60, 20);
  const shrunk = meanSquaredError(truth, shrinkEstimator, 60, 20);
  assert.ok(
    shrunk <= raw * 1.15,
    `多资产中等相关时不应明显恶化：${raw.toExponential(3)} -> ${shrunk.toExponential(3)}`,
  );
});

test("收缩：强度 λ 始终落在 [0,1]，退化输入不崩", () => {
  const cov = [
    [0.04, 0.01],
    [0.01, 0.02],
  ];
  for (const n of [10, 60, 500]) {
    const r = ledoitWolf(sampleObservations(cov, n, 7));
    assert.ok(r.intensity >= 0 && r.intensity <= 1, `λ 越界：${r.intensity}`);
  }
  assert.deepEqual(ledoitWolf([]).covariance, []);
  assert.equal(ledoitWolf([[0.01, 0.02]]).intensity, 0, "单行观测无法估计误差，应不收缩");
  const constObs = Array.from({ length: 30 }, () => [0.01, 0.02]);
  const r = ledoitWolf(constObs);
  assert.ok(r.covariance.every((row) => row.every((v) => Number.isFinite(v))), "输出必须有限");
});

test("收缩：完全共线的两个变量，样本协方差奇异，收缩后一定正定", () => {
  const rows: number[][] = [];
  const rand = rng(42);
  for (let t = 0; t < 50; t++) {
    const x = (rand() - 0.5) * 0.2;
    rows.push([x, 2 * x]);
  }
  const rets = toReturns(rows);
  const raw = covarianceMatrix(["a", "b"], rets, 1, { method: "sample" });
  assert.equal(isPositiveDefinite(raw), false, "共线数据的样本协方差是奇异的（这正是问题所在）");

  const shrunk = covarianceMatrix(["a", "b"], rets, 1, { method: "lw" });
  assert.ok(isPositiveDefinite(shrunk), "收缩后必须正定");
  assert.ok(Math.abs(shrunk[0]![0]! - raw[0]![0]!) < 1e-9, "方差应保留");
});

test("收缩：常数相关性目标保持统一相关结构", () => {
  const cov = [
    [0.04, 0.01, 0.0],
    [0.01, 0.0225, 0.0],
    [0.0, 0.0, 0.01],
  ];
  const obs = sampleObservations(cov, 200, 11);
  const { target } = ledoitWolf(obs, "constant_correlation");
  // 对角线 = **样本**方差（不是真实值）：收缩保住的是样本里的方差信息
  const sampleVarA = obs.reduce((a, r) => a + (r[0]! - obs.reduce((s2, x) => s2 + x[0]!, 0) / obs.length) ** 2, 0) / (obs.length - 1);
  assert.ok(Math.abs(target[0]![0]! - sampleVarA) < 1e-9, "对角线=样本方差");
  const r01 = target[0]![1]! / Math.sqrt(target[0]![0]! * target[1]![1]!);
  const r02 = target[0]![2]! / Math.sqrt(target[0]![0]! * target[2]![2]!);
  const r12 = target[1]![2]! / Math.sqrt(target[1]![1]! * target[2]![2]!);
  assert.ok(Math.abs(r01 - r02) < 1e-9 && Math.abs(r01 - r12) < 1e-9, "成对相关系数应统一");
});

test("收缩：HRP 可用收缩相关性；两资产时权重不受影响（三资产时受聚类影响）", () => {
  const constraints = { maxPositionWeight: 1, grossCap: 1 };

  // p=2 时 HRP 的簇划分只有 {A},{B}，权重只由方差决定；而对角目标保住了方差，
  // 所以两种协方差估计必然给出同一组权重 —— 这是应有性质，不是"没生效"。
  const cov = [
    [0.04, 0.002],
    [0.002, 0.0225],
  ];
  const obs = sampleObservations(cov, 80, 3);
  const rets = [obs.map((r) => r[0]!), obs.map((r) => r[1]!)];
  const wSample = riskParityWeights(["A", "B"], rets, constraints, 252, "sample" as CovarianceMethod);
  const wLw = riskParityWeights(["A", "B"], rets, constraints, 252, "lw" as CovarianceMethod);
  for (const w of [wSample, wLw]) {
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6, `权重和应为 1，实际 ${sum}`);
    assert.ok(Object.values(w).every((x) => x > 0 && x <= 1));
  }
  assert.ok(
    Math.abs((wSample.A ?? 0) - (wLw.A ?? 0)) < 1e-6,
    `两资产时两种估计应完全一致（权重只取决于方差）：${wSample.A} vs ${wLw.A}`,
  );

  // p=3：相关性会影响聚类结构，收缩后仍必须给出合法权重
  const cov3 = [
    [0.04, 0.03, 0.02],
    [0.03, 0.035, 0.025],
    [0.02, 0.025, 0.03],
  ];
  const obs3 = sampleObservations(cov3, 60, 8);
  const rets3 = [obs3.map((r) => r[0]!), obs3.map((r) => r[1]!), obs3.map((r) => r[2]!)];
  const w3 = riskParityWeights(["A", "B", "C"], rets3, constraints, 252, "lw" as CovarianceMethod);
  const sum3 = Object.values(w3).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum3 - 1) < 1e-6, `三资产权重和应为 1，实际 ${sum3}`);
  assert.ok(Object.values(w3).every((x) => x > 0), "权重都应为正");
});
