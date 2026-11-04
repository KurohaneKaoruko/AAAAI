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
import { clamp, mean, round, EXIT_Z } from "./momentum.js";

/** 冷却解除门槛：出场后 z 必须先回到均值附近（|z| < REARM_Z），同方向才允许再进场。 */
const REARM_Z = 1.2;

export class MeanReversionStrategy implements Strategy {
  readonly name = "bollinger-meanrev";
  readonly warmup: number;
  /** 迟滞状态：进场后持有到回归/止损/超时（详见 generate 内注释） */
  private readonly hold = new Map<string, { dir: 1 | -1; sinceBar: number }>();
  private readonly barSeq = new Map<string, number>();
  /** 冷却状态：上一次离场的方向；z 回到均值附近（REARM_Z 内）才解除 */
  private readonly cooldown = new Map<string, 1 | -1>();

  constructor(
    /** 短期趋势过滤窗口 */
    private readonly fastWindow = 5,
    /** 布林带均值/标准差窗口 */
    private readonly slowWindow = 20,
    private readonly maxWeight = 0.5,
    private readonly allowShort = false,
    /**
     * 进场门槛：1.5 个标准差（实测对比过 2.0：更深的进场在这个窗口里
     * 是更深的飞刀，收益反而更差；门槛的意义在冷却期与持仓纪律，不在深度）。
     */
    private readonly entryZ = 1.5,
    /** 短均线相对慢均线超过这个幅度时，视为强趋势，不做逆势 */
    private readonly trendMax = 0.0025,
    /** 最长持仓根数：均值迟迟不回归就撤，防止资金被死仓占住 */
    private readonly maxHold = 24,
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

    /**
     * 迟滞状态：进场后持有到「回到均值附近」（|z| < exitZ）才离场。
     * 旧版无状态：z > entryZ 的每一根都重新输出做空目标、z 回落到 entryZ
     * 下方立刻归零 —— 缓跌段反复开空平空、反弹段反复被打脸，一个来回
     * ≈30bps 摩擦。均值回归的出场条件本来就是「回归」：没回归就拿着，
     * 这才是策略本义，而不是每根 K 线重新做一遍入场决定。
     */
    const held = this.hold.get(symbol);
    const seq = (this.barSeq.get(symbol) ?? 0) + 1;
    this.barSeq.set(symbol, seq);

    /**
     * 冷却期：刚离场时记住方向；z 回到均值附近（|z| < REARM_Z）才解除。
     *
     * 没有冷却的话，「止损/超时出场 → z 仍然在门槛外 → 下一根立即重新进场」
     * 形成进出循环：12:05 进 → 12:15 止损平 → 12:20 又进，每次循环交一轮
     * 全额手续费。均值回归的前提是「价格会回来」，刚止损说明这个前提暂时
     * 不成立 —— 必须等价格证明自己回到均值附近（状态重置），才允许同方向
     * 再赌一次。
     */
    const cooling = this.cooldown.get(symbol);
    if (cooling !== undefined && Math.abs(z) < REARM_Z) this.cooldown.delete(symbol);

    let target = 0;
    let regime = "flat";
    if (!held) {
      if (z <= -this.entryZ && trend >= -this.trendMax && this.canEnter(symbol, 1)) {
        const scale = clamp(0.5 + (Math.abs(z) - this.entryZ) / 2, 0.5, 1.25);
        target = this.maxWeight * scale;
        this.hold.set(symbol, { dir: 1, sinceBar: seq });
        this.cooldown.delete(symbol);
        regime = "oversold-long";
      } else if (z >= this.entryZ && this.allowShort && trend <= this.trendMax && this.canEnter(symbol, -1)) {
        const scale = clamp(0.5 + (Math.abs(z) - this.entryZ) / 2, 0.5, 1.25);
        target = -this.maxWeight * scale;
        this.hold.set(symbol, { dir: -1, sinceBar: seq });
        this.cooldown.delete(symbol);
        regime = "overbought-short";
      }
    } else {
      const heldBars = seq - held.sinceBar;
      const backToMean = Math.abs(z) < EXIT_Z;
      // 止损：逆着持仓方向的 z 越走越深（可能不是回归而是崩塌），及时认错
      const goingWrong = (held.dir > 0 ? -z : z) > this.entryZ * 2;
      if (backToMean || goingWrong || heldBars >= this.maxHold) {
        this.hold.delete(symbol);
        // 离场即进入同方向冷却：等 z 回到均值附近才允许再进
        this.cooldown.set(symbol, held.dir);
        target = 0;
        regime = backToMean ? "mean-touch-exit" : goingWrong ? "stop-exit" : "timeout-exit";
      } else {
        // 没回归、没走坏、没超时：持仓不动（按进场方向保持目标权重）
        target = held.dir * this.maxWeight;
        regime = held.dir > 0 ? "hold-long" : "hold-short";
      }
    }

    return {
      symbol,
      timestamp: bars[bars.length - 1]!.timestamp,
      targetWeight: round(clamp(target, -this.maxWeight, this.maxWeight)),
      confidence: round(clamp(Math.abs(z) / (this.entryZ * 2), 0, 1)),
      reason: `${regime} z=${z.toFixed(2)} trend=${(trend * 100).toFixed(2)}% mean=${band.mean.toFixed(4)} sd=${band.sd.toFixed(4)}`,
    };
  }

  /** 同方向冷却中则不允许进场（反向不受限：方向都变了，赌的就是新故事）。 */
  private canEnter(symbol: string, dir: 1 | -1): boolean {
    return this.cooldown.get(symbol) !== dir;
  }
}
