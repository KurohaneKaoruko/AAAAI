/**
 * 布林带 / 均值回归策略。
 *
 * 学术上，均值回归最经典的证据来自配对交易（Gatev, Goetzmann & Rouwenhorst,
 * 2006）以及短期反转因子；这里用单标的布林带实现一个更易落地的版本：
 * - 价格偏离慢均线超过 entryZ 个标准差时反向入场；
 * - 用短均线方向做“别接飞刀”过滤：强下跌中不买、强上涨中不追空；
 * - 回到均值附近（|z| 很小）就不再做多/做空，避免在中间地带反复交易。
 *
 * 它适合震荡行情；趋势行情应使用动量/突破/自适应趋势引擎。
 */

import type { Signal } from "../core/types.js";
import type { Strategy, StrategyContext } from "./strategy.js";
import { bollinger } from "./adaptiveTrend.js";
import { clamp, mean, round } from "./momentum.js";

export class MeanReversionStrategy implements Strategy {
  readonly name = "bollinger-meanrev";
  readonly warmup: number;

  constructor(
    /** 短期趋势过滤窗口 */
    private readonly fastWindow = 5,
    /** 布林带均值/标准差窗口 */
    private readonly slowWindow = 20,
    private readonly maxWeight = 0.5,
    private readonly allowShort = false,
    private readonly entryZ = 1.5,
    /** 短均线相对慢均线超过这个幅度时，视为强趋势，不做逆势 */
    private readonly trendMax = 0.0025,
  ) {
    if (!(fastWindow > 0) || !(slowWindow > fastWindow)) {
      throw new Error(`MeanReversionStrategy 要求 0 < fastWindow(${fastWindow}) < slowWindow(${slowWindow})`);
    }
    if (!(maxWeight > 0)) throw new Error("MeanReversionStrategy 的 maxWeight 必须为正");
    this.warmup = slowWindow + 1;
  }

  async generate({ symbol, bars }: StrategyContext): Promise<Signal | null> {
    if (bars.length < this.warmup) return null;
    const closes = bars.map((b) => b.close);
    const close = closes[closes.length - 1]!;
    const band = bollinger(closes, this.slowWindow);
    if (!(band.sd > 0) || !(band.mean > 0)) return null;
    const z = (close - band.mean) / band.sd;
    const shortMa = mean(closes.slice(-this.fastWindow));
    const trend = (shortMa - band.mean) / band.mean;

    let target = 0;
    let regime = "flat";
    if (z <= -this.entryZ && trend >= -this.trendMax) {
      const scale = clamp(0.5 + (Math.abs(z) - this.entryZ) / 2, 0.5, 1.25);
      target = this.maxWeight * scale;
      regime = "oversold-long";
    } else if (z >= this.entryZ && this.allowShort && trend <= this.trendMax) {
      const scale = clamp(0.5 + (Math.abs(z) - this.entryZ) / 2, 0.5, 1.25);
      target = -this.maxWeight * scale;
      regime = "overbought-short";
    }

    return {
      symbol,
      timestamp: bars[bars.length - 1]!.timestamp,
      targetWeight: round(clamp(target, -this.maxWeight, this.maxWeight)),
      confidence: round(clamp(Math.abs(z) / (this.entryZ * 2), 0, 1)),
      reason: `${regime} z=${z.toFixed(2)} trend=${(trend * 100).toFixed(2)}% mean=${band.mean.toFixed(4)} sd=${band.sd.toFixed(4)}`,
    };
  }
}
