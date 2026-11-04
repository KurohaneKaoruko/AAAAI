/**
 * 双均线动量策略：快慢均线定方向，**按噪声归一**定大小（示例基线）。
 *
 * 旧版把「快慢均线差 ×10」直接当仓位用，问题很实在：均线差没有量纲基准 ——
 * 波动大的品种差 10% 是常态（永远满仓），1m 这类安静周期差 0.1% 就到顶了
 * （几乎永不建仓）。同一个策略在不同波动率上行为完全不同，震荡行情里还会
 * 围着 0 抖动、来回进出白交手续费。
 *
 * 现在信号是趋势的 t 统计量：均线差 ÷ 「纯噪声下这个差该有的标准差」。
 * 噪声尺度有闭式解（见 noiseScale）：随机游走上 z 的标准差恰好为 1，
 * 于是门槛有了明确含义 —— z<1 表示「这轮趋势连噪声都解释不了」，空仓；
 * z≥2 表示「两倍于噪声的趋势」，满配。波动大就自动把仓位压小，
 * 波动小就自动放大，同一套参数在 1m 与 1d、币和股上说的是同一种语言。
 */

import type { Bar, Signal } from "../core/types.js";
import type { Strategy, StrategyContext } from "./strategy.js";

/** 进场门槛：趋势强度至少要盖过 1.5 倍噪声才值得进场（含手续费的安全边际）。 */
export const ENTER_Z = 1.5;
/** 满配门槛：2 倍噪声以上不再加仓（再高的 z 只是更确定，不是更多趋势）。 */
export const FULL_Z = 2;
/**
 * 出场门槛：持仓后趋势衰减到 0.5 倍噪声以下才离场。
 *
 * 进场带(1.5) ≠ 出场带(0.5)，中间是**迟滞带**：已有仓位在带内保持不动。
 * 旧版进出同一门槛（1.0），z 在门槛附近每根 K 线来回穿越 —— 真实行情里
 * 一天能进出几十次，每次一个来回 ≈30bps 摩擦，方向还没亏钱、手续费先亏穿。
 * 迟滞不是新发明：恒温器、施密特触发器、唐奇安通道（本仓库 breakout 引擎）
 * 全是「宽条件进、窄条件出」的同款结构。
 */
export const EXIT_Z = 0.5;
/** 最短持仓：进场后至少持有几根 K 线，出场所不适用于刚进场的单（防单根反向噪声）。 */
export const MIN_HOLD_BARS = 3;

export class MomentumStrategy implements Strategy {
  readonly name = "momentum";
  readonly warmup: number;
  /**
   * 迟滞状态：每个标的记住当前持仓方向与进场时的 K 线序号。
   *
   * 策略实例在机器人/回测里与标的一一对应（每个标的独立实例），所以按实例
   * 记一份即可。旧版无状态、每根 K 线从零算目标权重，z 在门槛附近抖一下
   * 目标就从 50% 跳到 0 再跳回来 —— 每次跳变都是一笔真实成交。
   */
  private readonly hold = new Map<string, { dir: 1 | -1; sinceBar: number }>();
  /** 只用于统计进场的递增计数（按 symbol 记） */
  private readonly barSeq = new Map<string, number>();

  constructor(
    private readonly fast = 2,
    private readonly slow = 8,
    private readonly maxWeight = 0.5,
    /** 合约模式：趋势向下时输出负目标权重；现货必须保持 false */
    private readonly allowShort = false,
  ) {
    if (fast <= 0 || slow <= 0 || fast >= slow) {
      throw new Error(`MomentumStrategy 要求 0 < fast(${fast}) < slow(${slow})`);
    }
    this.warmup = slow;
  }

  async generate({ symbol, bars }: StrategyContext): Promise<Signal | null> {
    if (bars.length < this.warmup) return null;
    const score = trendScore(bars, this.fast, this.slow);
    if (!score) return null;
    const { z, fastMa, slowMa, sigma } = score;

    const seq = (this.barSeq.get(symbol) ?? 0) + 1;
    this.barSeq.set(symbol, seq);
    const held = this.hold.get(symbol);

    let targetWeight = 0;
    let event = "";
    if (!held) {
      // 空仓：强度盖过进场带（ENTER_Z 倍噪声）才建仓，一次给满目标权重。
      // 旧版在这里按 z 连续定仓位 —— 持仓后每根 K 线重新算一遍，z 抖一下
      // 权重就变，每次变化都是一笔真实成交。仓位只在进场时定一次。
      if (Math.abs(z) >= ENTER_Z) {
        const dir = z > 0 ? 1 : -1;
        if (dir > 0 || this.allowShort) {
          this.hold.set(symbol, { dir: dir as 1 | -1, sinceBar: seq });
          targetWeight = dir * this.maxWeight;
          event = `enter${dir > 0 ? "long" : "short"}`;
        }
      }
    } else {
      // 持仓：迟滞带。趋势还没衰减到出场带（EXIT_Z 倍噪声）以下 → 满仓拿住，什么都不做。
      // 反向信号强到越过进场带 → 立刻翻仓（不等衰减，趋势已经掉头了）。
      const sameDirStrength = held.dir > 0 ? z : -z;
      const oppositeStrength = -sameDirStrength;
      const heldBars = seq - held.sinceBar;
      const flipped = oppositeStrength >= ENTER_Z;
      const decayed = sameDirStrength < EXIT_Z && heldBars >= MIN_HOLD_BARS;
      if (flipped || decayed) {
        this.hold.delete(symbol);
        targetWeight = 0;
        event = `exit${held.dir > 0 ? "long" : "short"}${flipped ? "-flip" : ""}`;
      } else {
        targetWeight = held.dir * this.maxWeight;
      }
    }

    return {
      symbol,
      timestamp: bars[bars.length - 1]!.timestamp,
      targetWeight: round(targetWeight),
      confidence: round(Math.min(Math.abs(z) / FULL_Z, 1)),
      reason: `fast_ma=${fastMa.toFixed(4)} slow_ma=${slowMa.toFixed(4)} z=${z.toFixed(2)} noise=${sigma.toFixed(4)}${event ? ` ${event}` : ""}${targetWeight < 0 ? " short" : ""}`,
    };
  }
}

/**
 * 趋势打分：均线差 ÷ 噪声尺度。
 *
 * 返回 null 表示数据不足以判断（价格非正/窗口不足）；
 * strength<0 时 z<0，调用方据此空仓（本策略只做多）。
 */
export function trendScore(
  bars: Bar[],
  fast: number,
  slow: number,
): { strength: number; sigma: number; z: number; fastMa: number; slowMa: number } | null {
  if (bars.length < slow) return null;
  const window = bars.slice(-slow);
  const closes = window.map((b) => b.close);
  const fastMa = mean(closes.slice(-fast));
  const slowMa = mean(closes);
  if (!(slowMa > 0)) return null;
  const strength = (fastMa - slowMa) / slowMa;

  // 单根收益的样本标准差（用慢窗口内的收益估计当下噪声）
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1]!;
    if (prev > 0) rets.push(closes[i]! / prev - 1);
  }
  const sigma = stdOf(rets);
  if (!(sigma > 0)) return null; // 一条完全平的线：既没有趋势也没有噪声，无从判断

  const z = strength / (sigma * noiseScale(fast, slow));
  return { strength, sigma, z, fastMa, slowMa };
}

/**
 * 噪声尺度：纯随机游走（零漂移、单根波动 σ）下，「快慢均线差」的标准差 = σ·noiseScale。
 *
 * 闭式推导：距今第 k 根的收益（k=1 最新）出现在最近 k 根价格里，
 * 在快线均值的系数是 min(k,fast)/fast、在慢线均值的系数是 k/slow，于是
 *   k ≤ fast          系数 = k/fast − k/slow      （部分抵消）
 *   fast < k ≤ slow   系数 = 1 − k/slow           （更早的收益逐根淡出）
 *   k > slow          系数 = 0                    （窗口之外的收益两边都没有）
 * 方差 = σ²·Σ 系数²。这就是「噪声下该有多大均线差」的基准，
 * test/strategy.test.ts 用随机游走断言 z 的标准差 ≈ 1、并用蒙特卡洛
 * 对上闭式解，锁住它。
 */
export function noiseScale(fast: number, slow: number): number {
  let sumSquares = 0;
  for (let k = 1; k <= fast; k += 1) {
    const c = k / fast - k / slow;
    sumSquares += c * c;
  }
  for (let k = fast + 1; k <= slow; k += 1) {
    const c = 1 - k / slow;
    sumSquares += c * c;
  }
  return Math.sqrt(sumSquares);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 样本标准差（n−1 分母；n<2 时为 0）。 */
export function stdOf(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const ss = values.reduce((acc, v) => acc + (v - m) * (v - m), 0);
  return Math.sqrt(ss / (values.length - 1));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function round(value: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
