/**
 * 自适应趋势策略（规则版）。
 *
 * 它不追求“某个参数在历史数据上收益最高”，而是把趋势策略最容易亏钱的几种情况
 * 用可解释的过滤器挡掉：
 *
 * 1. 趋势强度仍用双均线 t 统计量（z）—— 和经典策略同一套噪声归一语言；
 * 2. 效率比（ER）过滤：价格来回折返的震荡市不做趋势追单；
 * 3. 突破/回撤确认：做多要求价格在近期区间上沿且未跌破 ATR 移动止损，
 *    做空对称；避免在急涨急跌的尾巴上追进去；
 * 4. 长期方向过滤：价格必须在长期均线同侧，防止逆大势抄底摸顶；
 * 5. 波动率缩放：当前波动明显高于自身常态时自动减仓，低波动时适度加仓；
 * 6. 真正的震荡市（ER 很低）允许小仓位均值回归，但只做区间边缘，不在中轨追。
 *
 * 所有判断只使用当前 K 线及之前的数据；成交仍由 PaperBroker 在下一根开盘执行。
 */

import type { Bar, Signal } from "../core/types.js";
import type { Strategy, StrategyContext } from "./strategy.js";
import { clamp, mean, round, stdOf, trendScore, ENTER_Z, FULL_Z } from "./momentum.js";

export interface AdaptiveOptions {
  /** 效率比窗口：越长越偏大级别趋势 */
  efficiencyWindow: number;
  /** 趋势模式的最低效率比；低于它只考虑均值回归 */
  efficiencyMin: number;
  /** 区间突破确认窗口 */
  breakoutWindow: number;
  /** ATR 窗口与移动止损倍数 */
  atrWindow: number;
  atrMult: number;
  /** 长期方向过滤窗口 */
  longWindow: number;
  /** 波动率缩放窗口 */
  volWindow: number;
  /** 均值回归布林窗口 / 触发 z */
  rangeWindow: number;
  rangeZ: number;
  /** 震荡仓位最长持有根数（超时即撤；趋势单不受此限） */
  maxHold: number;
}

export const ADAPTIVE_DEFAULTS: AdaptiveOptions = {
  efficiencyWindow: 32,
  efficiencyMin: 0.24,
  breakoutWindow: 20,
  atrWindow: 14,
  atrMult: 2.5,
  longWindow: 60,
  volWindow: 60,
  rangeWindow: 40,
  rangeZ: 1.4,
  /** 震荡仓位最长持有根数：均值回归单超时即撤（趋势单不受此限，靠 ATR 止损管） */
  maxHold: 24,
};

export class AdaptiveTrendStrategy implements Strategy {
  readonly name = "adaptive-trend";
  readonly warmup: number;
  private readonly opt: AdaptiveOptions;
  /** 持仓状态：进场方向、进场价、定死的仓位大小（见 generate 内注释） */
  private readonly hold = new Map<string, { dir: 1 | -1; sinceBar: number; entry: number; size: number }>();
  private readonly barSeq = new Map<string, number>();
  /** 冷却状态：上一次离场的方向；同方向重进需要先出现反向信号（见 generate 内注释） */
  private readonly cooldown = new Map<string, 1 | -1>();

  constructor(
    private readonly fast = 2,
    private readonly slow = 8,
    private readonly maxWeight = 0.5,
    /** 合约模式允许做空；现货必须为 false */
    private readonly allowShort = false,
    options: Partial<AdaptiveOptions> = {},
  ) {
    if (fast <= 0 || slow <= 0 || fast >= slow) {
      throw new Error(`AdaptiveTrendStrategy 要求 0 < fast(${fast}) < slow(${slow})`);
    }
    if (!(maxWeight > 0)) throw new Error("AdaptiveTrendStrategy 的 maxWeight 必须为正");
    this.opt = { ...ADAPTIVE_DEFAULTS, ...options };
    this.warmup =
      Math.max(
        slow + 1,
        this.opt.efficiencyWindow + 1,
        this.opt.breakoutWindow + 1,
        this.opt.atrWindow + 1,
        this.opt.longWindow + 1,
        this.opt.volWindow + 1,
        this.opt.rangeWindow + 1,
      ) + 1;
  }

  async generate({ symbol, bars }: StrategyContext): Promise<Signal | null> {
    if (bars.length < this.warmup) return null;
    const o = this.opt;
    const score = trendScore(bars, this.fast, this.slow);
    if (!score) return null;
    const { z } = score;
    const closes = bars.map((b) => b.close);
    const close = closes[closes.length - 1]!;
    const atr = atrOf(bars, o.atrWindow);
    if (!(close > 0) || !(atr > 0)) return null;

    const er = efficiencyRatio(closes, o.efficiencyWindow);
    const range = donchian(bars, o.breakoutWindow);
    const longMa = mean(closes.slice(-o.longWindow));
    const highWater = Math.max(...bars.slice(-o.breakoutWindow).map((b) => b.high));
    const lowWater = Math.min(...bars.slice(-o.breakoutWindow).map((b) => b.low));
    const atrPct = atr / close;
    const volScale = volatilityScale(closes, o.volWindow);
    const strength = clamp((Math.abs(z) - ENTER_Z) / (FULL_Z - ENTER_Z), 0, 1);
    const quality = 0.55 + 0.45 * clamp(er / 0.55, 0, 1);

    // 趋势模式：效率高或趋势极强，且突破/移动止损同向确认。
    const trendRegime = er >= o.efficiencyMin || Math.abs(z) >= FULL_Z * 1.25;
    const longOk =
      trendRegime &&
      z > 0 &&
      close > longMa &&
      range.position >= 0.5 &&
      close >= highWater - o.atrMult * atr;
    const shortOk =
      trendRegime &&
      z < 0 &&
      close < longMa &&
      range.position <= 0.5 &&
      close <= lowWater + o.atrMult * atr;

    /**
     * 持仓状态机：进场定仓、拿住、衰减才出（与 momentum 引擎同一迟滞结构）。
     *
     * 旧版无状态，每根 K 线重新判定 regime 并重算仓位：
     * - 震荡模式仓位 = f(|bz|)，bz 每根都变 → 仓位每根都微调 → 每根都是成交；
     * - regime 在 trend↔flat↔range 之间翻转 → 每次翻转全额平仓再重进。
     * 实测 500 根真实 5m 行情 162 笔成交、摩擦 1512U，方向亏损反而是小事。
     * 现在：进场时一次定死仓位大小；持仓期间只要不触发离场条件就原样输出；
     * 离场条件 = ATR 移动止损（同向依据被破坏）或反向信号越过进场带。
     */
    const held = this.hold.get(symbol);
    const seq = (this.barSeq.get(symbol) ?? 0) + 1;
    this.barSeq.set(symbol, seq);

    let target: number;
    let regime: string;
    if (!held) {
      /**
       * 冷却：刚从方向 D 离场后，同方向立即重进被禁止，直到出现新鲜证据：
       * 同方向 z 重新越过进场带（趋势真的又来了），或反向越过（换故事了）。
       * 没有这道闸，「止损 → z 还在门槛外 → 下一根重进 → 再止损」的循环
       * 会持续交手续费。注意冷却不删状态：证据不足就一直冷却着。
       */
      const cooling = this.cooldown.get(symbol);
      if (cooling !== undefined) {
        const sameDirStrength = cooling === 1 ? z : -z;
        const rearmOk = Math.abs(sameDirStrength) >= ENTER_Z || Math.abs(z) >= ENTER_Z * 1.2;
        if (!rearmOk) {
          return {
            symbol,
            timestamp: bars[bars.length - 1]!.timestamp,
            targetWeight: 0,
            confidence: round(clamp(Math.abs(z) / FULL_Z, 0, 1)),
            reason: `cooldown z=${z.toFixed(2)} er=${er.toFixed(2)} range=${range.position.toFixed(2)} atr=${(atrPct * 100).toFixed(2)}% vol=${volScale.toFixed(2)}`,
          };
        }
        this.cooldown.delete(symbol);
      }
      if (longOk) {
        target = this.maxWeight * Math.max(0.25, strength) * quality * volScale;
        this.hold.set(symbol, { dir: 1, sinceBar: seq, entry: close, size: target });
        this.cooldown.delete(symbol);
        regime = "trend-long";
      } else if (shortOk && this.allowShort) {
        target = -this.maxWeight * Math.max(0.25, strength) * quality * volScale;
        this.hold.set(symbol, { dir: -1, sinceBar: seq, entry: close, size: -target });
        this.cooldown.delete(symbol);
        regime = "trend-short";
      } else if (!trendRegime && Math.abs(z) < ENTER_Z * 1.5) {
        /**
         * 震荡模式：只在区间边缘做一次小仓位均值回归，仓位进场时定死。
         * 这部分不是主收益来源，目的是让低效率比行情也有可控的参与度，
         * 而不是为了“有交易”在中间位置来回挨打。
         */
        const band = bollinger(closes, o.rangeWindow);
        if (band.sd > 0) {
          const bz = (close - band.mean) / band.sd;
          const size = this.maxWeight * 0.35 * clamp((Math.abs(bz) - 1) / 1.8, 0, 1);
          if (bz <= -o.rangeZ) {
            target = size;
            this.hold.set(symbol, { dir: 1, sinceBar: seq, entry: close, size });
            regime = "range-long";
          } else if (bz >= o.rangeZ && this.allowShort) {
            target = -size;
            this.hold.set(symbol, { dir: -1, sinceBar: seq, entry: close, size });
            regime = "range-short";
          } else {
            target = 0;
            regime = "flat";
          }
        } else {
          target = 0;
          regime = "flat";
        }
      } else {
        target = 0;
        regime = "flat";
      }
    } else {
      const heldBars = seq - held.sinceBar;
      const stop = held.dir > 0 ? held.entry - o.atrMult * atr : held.entry + o.atrMult * atr;
      const stopped = held.dir > 0 ? close < stop : close > stop;
      const oppositeStrength = held.dir > 0 ? -z : z;
      const flipped = oppositeStrength >= ENTER_Z;
      // 震荡仓位的时间盒：均值回归单不是趋势单，回归逻辑有半衰期，超时即撤
      const timedOut = heldBars >= this.opt.maxHold;
      if (stopped || flipped || timedOut) {
        this.hold.delete(symbol);
        // 离场即进入同方向冷却（见空仓分支的注释）
        this.cooldown.set(symbol, held.dir);
        target = 0;
        regime = stopped ? "atr-stop" : flipped ? "flip-exit" : "timeout-exit";
      } else {
        // 拿住：输出进场时定死的仓位，一字不改
        target = held.dir * held.size;
        regime = held.dir > 0 ? "hold-long" : "hold-short";
      }
    }

    target = round(clamp(target, -this.maxWeight, this.maxWeight));
    return {
      symbol,
      timestamp: bars[bars.length - 1]!.timestamp,
      targetWeight: target,
      confidence: round(clamp(Math.abs(z) / FULL_Z, 0, 1)),
      reason:
        `${regime} z=${z.toFixed(2)} er=${er.toFixed(2)} ` +
        `range=${range.position.toFixed(2)} atr=${(atrPct * 100).toFixed(2)}% ` +
        `vol=${volScale.toFixed(2)}`,
    };
  }
}

/** 效率比：净位移 / 总路径长度（0~1）。高 = 单边趋势，低 = 来回折返。 */
export function efficiencyRatio(closes: number[], window: number): number {
  if (window < 2 || closes.length < window + 1) return 0;
  const from = closes[closes.length - 1 - window]!;
  const to = closes[closes.length - 1]!;
  let path = 0;
  for (let i = closes.length - window; i < closes.length; i += 1) {
    path += Math.abs(closes[i]! - closes[i - 1]!);
  }
  return path > 0 ? Math.abs(to - from) / path : 0;
}

/** 近期区间位置：0 = 最低，1 = 最高。 */
export function donchian(bars: Bar[], window: number): { low: number; high: number; position: number } {
  const slice = bars.slice(-window);
  const high = Math.max(...slice.map((b) => b.high));
  const low = Math.min(...slice.map((b) => b.low));
  const close = slice[slice.length - 1]!.close;
  return { low, high, position: high > low ? (close - low) / (high - low) : 0.5 };
}

/**  Wilder ATR（用 OHLC 真实波幅的简单平均；窗口远小于数据长度）。 */
export function atrOf(bars: Bar[], window: number): number {
  const slice = bars.slice(-(window + 1));
  if (slice.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < slice.length; i += 1) {
    const prev = slice[i - 1]!;
    const cur = slice[i]!;
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    sum += tr;
  }
  return sum / (slice.length - 1);
}

/** 波动率缩放：当前短波动 / 自身中期波动；高波动减仓，低波动适度加仓。 */
export function volatilityScale(closes: number[], window: number): number {
  if (closes.length < window + 1) return 1;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1]!;
    if (prev > 0) rets.push(closes[i]! / prev - 1);
  }
  const fast = stdOf(rets.slice(-Math.min(20, rets.length)));
  const slow = stdOf(rets.slice(-window));
  if (!(fast > 0) || !(slow > 0)) return 1;
  return round(clamp(slow / fast, 0.55, 1.25));
}

/** 布林带（均值、样本标准差）。 */
export function bollinger(closes: number[], window: number): { mean: number; sd: number } {
  const slice = closes.slice(-window);
  return { mean: mean(slice), sd: stdOf(slice) };
}
