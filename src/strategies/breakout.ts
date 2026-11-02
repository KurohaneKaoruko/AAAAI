/**
 * 唐奇安通道突破（Turtle / Donchian breakout）的规则实现。
 *
 * 经典海龟规则的核心不是“突破就买”，而是：
 * - 用 N 日最高/最低通道定义入场（默认 slowWindow = 20）；
 * - 用更短的 M 日反向通道定义离场（fastWindow = 10）；
 * - 用 ATR 做止损/风险距离，避免单笔亏损失控。
 *
 * 这里用实例状态记录每个标的的方向与入场价；策略实例每个机器人/回测独立持有，
 * 因此状态不会跨账户串味。现货只做多，合约可通过 allowShort 做空。
 */

import type { Signal } from "../core/types.js";
import type { Strategy, StrategyContext } from "./strategy.js";
import { atrOf } from "./adaptiveTrend.js";
import { clamp, round } from "./momentum.js";

export class BreakoutStrategy implements Strategy {
  readonly name = "donchian-breakout";
  readonly warmup: number;
  /** symbol -> 1 多 / -1 空 / 0 空仓 */
  private readonly dirs = new Map<string, number>();
  /** symbol -> 入场价 */
  private readonly entries = new Map<string, number>();

  constructor(
    /** 离场反向通道窗口（通常小于 slowWindow） */
    private readonly exitWindow = 10,
    /** 入场通道窗口 */
    private readonly entryWindow = 20,
    private readonly maxWeight = 0.5,
    private readonly allowShort = false,
    private readonly atrWindow = 14,
    private readonly atrMult = 2.0,
  ) {
    if (exitWindow <= 0 || entryWindow <= 0 || exitWindow >= entryWindow) {
      throw new Error(`BreakoutStrategy 要求 0 < exitWindow(${exitWindow}) < entryWindow(${entryWindow})`);
    }
    if (!(maxWeight > 0)) throw new Error("BreakoutStrategy 的 maxWeight 必须为正");
    this.warmup = entryWindow + 1;
  }

  async generate({ symbol, bars }: StrategyContext): Promise<Signal | null> {
    if (bars.length < this.warmup) return null;
    const close = bars[bars.length - 1]!.close;
    const prior = bars.slice(0, -1);
    const entryHigh = Math.max(...prior.slice(-this.entryWindow).map((b) => b.high));
    const entryLow = Math.min(...prior.slice(-this.entryWindow).map((b) => b.low));
    const exitHigh = Math.max(...prior.slice(-this.exitWindow).map((b) => b.high));
    const exitLow = Math.min(...prior.slice(-this.exitWindow).map((b) => b.low));
    const atr = atrOf(bars, this.atrWindow);
    let dir = this.dirs.get(symbol) ?? 0;
    let entry = this.entries.get(symbol) ?? 0;
    let event = "hold";

    if (dir > 0) {
      // 多头离场：跌破短通道，或从入场价回撤超过 ATR 止损
      if (close < exitLow || (atr > 0 && close < entry - this.atrMult * atr)) {
        dir = 0;
        event = "exit-long";
      }
    } else if (dir < 0) {
      // 空头离场：突破短通道上沿，或从入场价反弹超过 ATR 止损
      if (close > exitHigh || (atr > 0 && close > entry + this.atrMult * atr)) {
        dir = 0;
        event = "exit-short";
      }
    }

    if (dir === 0) {
      if (close >= entryHigh) {
        dir = 1;
        entry = close;
        event = "break-long";
      } else if (this.allowShort && close <= entryLow) {
        dir = -1;
        entry = close;
        event = "break-short";
      }
    }

    if (dir === 0) {
      this.dirs.delete(symbol);
      this.entries.delete(symbol);
    } else {
      this.dirs.set(symbol, dir);
      this.entries.set(symbol, entry);
    }

    return {
      symbol,
      timestamp: bars[bars.length - 1]!.timestamp,
      targetWeight: round(clamp(dir * this.maxWeight, -this.maxWeight, this.maxWeight)),
      confidence: round(atr > 0 ? Math.min(1, (Math.abs(close - (dir > 0 ? entryHigh : entryLow)) / atr) + 0.4) : 0),
      reason:
        `${event} dir=${dir} entry=${entry.toFixed(4)} ` +
        `ch=${entryLow.toFixed(2)}~${entryHigh.toFixed(2)} exit=${exitLow.toFixed(2)}~${exitHigh.toFixed(2)} atr=${atr.toFixed(4)}`,
    };
  }
}
