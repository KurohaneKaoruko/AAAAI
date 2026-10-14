/** 双均线动量策略：快线上穿慢线做多，否则空仓（示例基线）。 */

import type { Bar, Signal } from "../core/types.js";
import type { Strategy, StrategyContext } from "./strategy.js";

export class MomentumStrategy implements Strategy {
  readonly name = "momentum";
  readonly warmup: number;

  constructor(
    private readonly fast = 5,
    private readonly slow = 20,
    private readonly maxWeight = 0.5,
  ) {
    if (fast <= 0 || slow <= 0 || fast >= slow) {
      throw new Error(`MomentumStrategy 要求 0 < fast(${fast}) < slow(${slow})`);
    }
    this.warmup = slow;
  }

  async generate({ symbol, bars }: StrategyContext): Promise<Signal | null> {
    if (bars.length < this.warmup) return null;
    const closes = bars.map((b) => b.close);
    const fastMa = mean(closes.slice(-this.fast));
    const slowMa = mean(closes.slice(-this.slow));
    if (slowMa <= 0) return null;
    const strength = (fastMa - slowMa) / slowMa;
    const targetWeight = clamp(strength * 10, 0, 1) * this.maxWeight;
    return {
      symbol,
      timestamp: bars[bars.length - 1]!.timestamp,
      targetWeight: round(targetWeight),
      confidence: round(Math.min(Math.abs(strength) * 10, 1)),
      reason: `fast_ma=${fastMa.toFixed(4)} slow_ma=${slowMa.toFixed(4)}`,
    };
  }
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function round(value: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
