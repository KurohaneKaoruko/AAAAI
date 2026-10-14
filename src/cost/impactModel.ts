/**
 * 交易成本模型：滑点不再是一个固定 bps，而是随订单规模与波动变化。
 *
 * 固定滑点会系统性地高估小单、低估大单 —— 回测因此显得比实际好。
 * 这里用 Almgren-Chriss 的平方根冲击定律（业界最常用的一阶近似）：
 *
 *   滑点 = 基础点差 + k · σ · sqrt(订单金额 / 日成交额)
 *
 * σ 取标的近端已实现波动率（由行情缓冲提供），日成交额用「价格 × 最近成交量 × 根数」
 * 估算；两者缺失时退回固定 bps，保证永远有一个可解释的兜底值。
 */

import { getLogger } from "../core/logger.js";

const log = getLogger("cost:impact");

export interface ImpactParams {
  /** 固定点差（bps），相当于最小摩擦 */
  baseBps: number;
  /** 冲击系数：0 表示纯固定滑点（关闭模型） */
  k: number;
  /** 滑点上限（bps），防止极端情况把回测打穿 */
  maxBps: number;
  /** 日成交量估算所用的 K 线根数 */
  windowBars: number;
}

export const DEFAULT_IMPACT: ImpactParams = {
  baseBps: 2,
  k: 0.35,
  maxBps: 200,
  windowBars: 20,
};

/** 单个标的的近期交易特征（由行情缓冲实时更新）。 */
export interface MarketMicroStats {
  /** 近端已实现波动率（标准差，日频口径） */
  volatility: number;
  /** 近端日均成交额估计 */
  dailyTurnover: number;
}

export class CostModel {
  constructor(private readonly params: ImpactParams) {}

  /** 该标的是否有足够数据走冲击模型。 */
  static usable(stats: MarketMicroStats | undefined, params = DEFAULT_IMPACT): boolean {
    if (!stats) return false;
    return stats.volatility > 0 && stats.dailyTurnover > 0 && params.k > 0;
  }

  /**
   * 计算单边滑点（bps）。
   * notional = 订单金额（绝对值）；price 仅用于日志与断言。
   */
  slippageBps(notional: number, stats: MarketMicroStats | undefined): number {
    const { baseBps, k, maxBps } = this.params;
    if (!CostModel.usable(stats, this.params) || !(notional > 0)) return baseBps;
    const s = stats!;
    const participation = notional / s.dailyTurnover; // 当日成交占比
    const impact = k * s.volatility * Math.sqrt(Math.min(participation, 1));
    const bps = Math.min(maxBps, baseBps + impact * 10_000);
    return Number(bps.toFixed(4));
  }

  /** 成交价（含方向）。 */
  execPrice(mid: number, side: "BUY" | "SELL", bps: number): number {
    const slip = (mid * bps) / 10_000;
    return side === "BUY" ? mid + slip : mid - slip;
  }
}

/** 由收盘价序列估算已实现波动率（日频口径：按根数的标准差）。 */
export function realizedVolatility(closes: number[], barsPerDay = 1440): number {
  if (closes.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const p0 = closes[i - 1]!;
    if (p0 > 0) rets.push(Math.log(closes[i]! / p0));
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (rets.length - 1);
  const perBar = Math.sqrt(Math.max(0, variance));
  // 放大到日频：波动率按 sqrt(时间) 缩放
  return perBar * Math.sqrt(Math.max(1, barsPerDay / 1440));
}

/** 由 K 线估算日均成交额。 */
export function dailyTurnover(bars: { close: number; volume: number }[], barsPerDay = 1440): number {
  if (bars.length === 0) return 0;
  const total = bars.reduce((acc, b) => acc + b.close * b.volume, 0);
  const perBar = total / bars.length;
  return perBar * barsPerDay;
}

/** 便捷：把冲击模型应用到一条成交上，返回成交价与实际滑点 bps（便于写进事件与统计）。 */
export function applyImpact(
  model: CostModel,
  mid: number,
  side: "BUY" | "SELL",
  quantity: number,
  stats: MarketMicroStats | undefined,
): { price: number; bps: number } {
  const bps = model.slippageBps(Math.abs(quantity * mid), stats);
  if (bps > model["params"].baseBps + 0.0001) {
    log.debug("冲击滑点 %.1f bps（订单占比 %.2f%%）", bps, ((Math.abs(quantity * mid) / (stats?.dailyTurnover || 1)) * 100).toFixed(2));
  }
  return { price: model.execPrice(mid, side, bps), bps };
}