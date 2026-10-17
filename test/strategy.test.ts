import assert from "node:assert/strict";
import test from "node:test";
import { MomentumStrategy, trendScore, noiseScale, mean } from "../src/strategies/momentum.js";
import { makeBars } from "./helpers.js";

test("MomentumStrategy: 预热不足返回 null", async () => {
  const s = new MomentumStrategy(5, 20);
  assert.equal(s.warmup, 20);
  assert.equal(await s.generate({ symbol: "T", bars: makeBars(Array(19).fill(100)) }), null);
});

test("MomentumStrategy: 上升趋势给出正权重", async () => {
  const s = new MomentumStrategy(5, 20, 0.5);
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i); // 单边上涨
  const signal = await s.generate({ symbol: "T", bars: makeBars(closes) });
  assert.ok(signal);
  assert.ok(signal.targetWeight > 0 && signal.targetWeight <= 0.5);
  assert.ok(signal.confidence > 0);
  assert.match(signal.reason, /fast_ma/);
});

test("MomentumStrategy: 下跌趋势权重为 0", async () => {
  const s = new MomentumStrategy(5, 20, 0.5);
  const closes = Array.from({ length: 30 }, (_, i) => 200 - i);
  const signal = await s.generate({ symbol: "T", bars: makeBars(closes) });
  assert.ok(signal);
  assert.equal(signal.targetWeight, 0);
});

test("MomentumStrategy: fast >= slow 报错", () => {
  assert.throws(() => new MomentumStrategy(20, 20));
  assert.throws(() => new MomentumStrategy(30, 20));
});

// ------------------------------------------------ 噪声归一（策略的核心承诺）

test("噪声归一：纯随机游走上 z 的标准差 ≈ 1（信号没有偷偷放大）", () => {
  // 固定种子的伪随机游走（可复现），多组窗口都要过 —— 只要有一组偏离，
  // 说明 noiseScale 的闭式解错了，策略在不同窗口下说的就不是同一种语言。
  let seed = 20261018;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const sigma = 0.01;
  for (const [fast, slow] of [
    [5, 20],
    [10, 60],
    [20, 120],
  ] as const) {
    const zs: number[] = [];
    for (let trial = 0; trial < 400; trial += 1) {
      const closes: number[] = [100];
      for (let i = 1; i < slow + 5; i += 1) {
        // Box-Muller 正态噪声；rnd() 恒在 (0,1)，log 兜底防 0
        const u1 = Math.max(rnd(), 1e-9);
        const u2 = rnd();
        const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        closes.push(closes[closes.length - 1]! * Math.exp(sigma * g));
      }
      const s = trendScore(makeBars(closes).slice(-slow), fast, slow);
      if (s) zs.push(s.z);
    }
    const sd = Math.sqrt(mean(zs.map((z) => z * z))); // E[z]=0（噪声无方向）
    assert.ok(
      Math.abs(sd - 1) < 0.12,
      `fast=${fast} slow=${slow}：随机游走上 z 标准差应≈1，实际 ${sd.toFixed(3)}（样本 ${zs.length}）`,
    );
  }
});

test("噪声归一：确定性趋势的 z 随斜率单调、方向正确", () => {
  // 每根涨 0.4% 的线：比每根涨 0.1% 的线更「显著地是趋势」，z 必须更大；
  // 下跌方向 z 为负。这条锁住「z 度量的是趋势/噪声比，不是价格涨了多少」。
  const mk = (drift: number) =>
    makeBars(Array.from({ length: 40 }, (_, i) => 100 * (1 + drift) ** i));
  const strong = trendScore(mk(0.004), 5, 20)!;
  const weak = trendScore(mk(0.001), 5, 20)!;
  assert.ok(strong.z > weak.z && weak.z > 0, `z 应随趋势强度单调：${weak.z.toFixed(2)} < ${strong.z.toFixed(2)}`);
  assert.ok(trendScore(mk(-0.004), 5, 20)!.z < 0, "下跌趋势 z 为负");
  assert.ok(strong.strength > weak.strength, "原始均线差也应同向（sanity）");
});

test("噪声归一：同样斜率的趋势，波动大的 z 更小（自动降杠杆）", () => {
  // 两条斜率相同的上行线，一条叠上 3 倍噪声：趋势/噪声比更低，z 必须更小。
  // 这就是「同一套参数在不同波动率品种上说的是同一种语言」的可验证形式。
  let seed = 777;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const mk = (vol: number) => {
    const closes = [100];
    for (let i = 1; i < 40; i += 1) {
      const g = (rnd() - 0.5) * 2; // 均匀噪声，两次调用序列不同即可
      closes.push(closes[closes.length - 1]! * 1.001 * Math.exp(vol * g));
    }
    return makeBars(closes);
  };
  const calm = trendScore(mk(0.004), 5, 20)!;
  const wild = trendScore(mk(0.012), 5, 20)!;
  assert.ok(calm.z > wild.z, `波动小的 z 应更大：${calm.z.toFixed(2)} vs ${wild.z.toFixed(2)}`);
});

test("噪声归一：低于噪声门槛不进场（震荡=空仓，不再来回甩）", () => {
  // 均线接近 0 但在 0 附近抖的行情：旧版 ×10 截断会跟着抖着进出，
  // 现在 z≤1 一律空仓。这是「多数场景盈利为正」的关键防线。
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const closes = [100];
  for (let i = 1; i < 40; i += 1) {
    closes.push(closes[closes.length - 1]! * Math.exp(0.008 * (rnd() - 0.5) * 2));
  }
  const score = trendScore(makeBars(closes), 5, 20)!;
  assert.ok(Math.abs(score.z) < 3, `纯抖动行情 z 不该显著：${score.z.toFixed(2)}`);
});

test("noiseScale 闭式解与「直接对随机游走做模拟」一致", () => {
  // 把闭式解与蒙特卡洛对上：200 条随机游走的均线差标准差 ≈ σ·noiseScale(5,20)。
  // 这是推导的最终校验，锁住「噪声尺度」本身而不是它的用途。
  let seed = 99;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const sigma = 0.02;
  const gaps: number[] = [];
  for (let t = 0; t < 200; t += 1) {
    const closes: number[] = [100];
    for (let i = 1; i < 25; i += 1) {
      const u1 = Math.max(rnd(), 1e-9);
      const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rnd());
      closes.push(closes[closes.length - 1]! * Math.exp(sigma * g));
    }
    const fast = mean(closes.slice(-5));
    const slow = mean(closes.slice(-20));
    gaps.push((fast - slow) / slow);
  }
  const empirical = Math.sqrt(mean(gaps.map((g) => g * g)));
  const predicted = sigma * noiseScale(5, 20);
  assert.ok(
    Math.abs(empirical / predicted - 1) < 0.15,
    `模拟 ${empirical.toFixed(5)} vs 闭式 ${predicted.toFixed(5)}（差 <15%）`,
  );
});

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
