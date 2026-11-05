/**
 * 逐档吃单撮合（L2 盘口微结构模型）。
 *
 * 为什么需要它：旧的模拟撮合按「下一根开盘价 ± 合成滑点」成交，订单规模
 * 对价格的影响全靠冲击模型**猜**——小单看不出差别，大单的成交价与真实
 * 交易所完全是两回事（真实市价单是逐档吃掉对手方挂单，吃多深由盘口
 * 深度决定，不是百分比）。开源事件驱动引擎（hftbacktest、Nautilus 的
 * fill model）的共识做法就是直接对 L2 盘口逐档撮合，我们遵循同一模型：
 *
 * 1. 市价 BUY 依序吃 asks（卖一→卖二→…），SELL 吃 bids；
 * 2. 均价 = Σ(档价×档量)/Σ档量 —— 天然包含「吃穿浅档的滑点」，
 *    且与订单规模相关：单子越大吃得越深，均价越差；
 * 3. 盘口深度不足时按 IOC（立即成交或取消）语义处理部分成交：
 *    能吃多少吃多少，剩余撤销——真实交易所的市价单就是这样，
 *    模拟盘假装"一定能全额成交"会高估策略容量；
 * 4. 手续费按真实费率表收 taker 费（市价单=吃单方），见 feeSchedule.ts。
 *
 * 这是纯函数模块：给定快照与订单返回成交结果，不做 IO、不持有状态，
 * 方便单测与回放核对。
 */

import type { BookLevel, OrderBookSnapshot } from "../exchanges/types.js";
import type { Side } from "../core/types.js";

/** 一次（可能部分）成交的结果。 */
export interface BookFillResult {
  /** 实际成交量（0 = 盘口为空，等于拒单） */
  filledQuantity: number;
  /** 成交均价（各档按量加权） */
  averagePrice: number;
  /** 吃到的最深一档价格（对账用：这是最差成交价） */
  worstPrice: number;
  /** 未成交的剩余量（IOC 语义下被撤销的部分） */
  unfilledQuantity: number;
  /** 消费的档数（1 = 只吃了一档，盘口很厚） */
  levelsConsumed: number;
  /** 相对盘口中间价的滑点（bps，正 = 比中间价差） */
  slippageBps: number;
}

/** 盘口中间价（无对手档时退化用买一/卖一）。 */
export function bookMidPrice(book: OrderBookSnapshot): number {
  const bestAsk = book.asks[0]?.price;
  const bestBid = book.bids[0]?.price;
  if (bestAsk !== undefined && bestBid !== undefined) return (bestAsk + bestBid) / 2;
  return bestAsk ?? bestBid ?? 0;
}

/**
 * 市价单逐档吃单。
 *
 *IOC 语义：盘口深度不足以吃满订单量时，剩余部分撤销（unfilledQuantity > 0），
 * 不虚构"按最后一档价格无限量供应"——那是给模拟盘开后门。真实交易所
 * 深度不够时市价单就是部分成交。
 */
export function fillMarketAgainstBook(
  book: OrderBookSnapshot,
  side: Side,
  quantity: number,
): BookFillResult {
  const levels: BookLevel[] = side === "BUY" ? book.asks : book.bids;
  const mid = bookMidPrice(book);
  if (!(quantity > 0) || levels.length === 0 || mid <= 0) {
    return { filledQuantity: 0, averagePrice: 0, worstPrice: 0, unfilledQuantity: quantity, levelsConsumed: 0, slippageBps: 0 };
  }

  let remaining = quantity;
  let cost = 0;
  let filled = 0;
  let worst = 0;
  let consumed = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    // 脏数据防御：跳过价格/数量非法的档（真实接口偶发零量档）
    if (!(level.price > 0) || !(level.quantity > 0)) continue;
    const take = Math.min(remaining, level.quantity);
    cost += take * level.price;
    filled += take;
    remaining -= take;
    worst = level.price;
    consumed += 1;
  }

  if (filled <= 0) {
    return { filledQuantity: 0, averagePrice: 0, worstPrice: 0, unfilledQuantity: quantity, levelsConsumed: 0, slippageBps: 0 };
  }

  const averagePrice = cost / filled;
  // 滑点以中间价为基准：BUY 均价高于中间价为正（多付），SELL 低于中间价为正（少收）
  const slip = side === "BUY" ? (averagePrice - mid) / mid : (mid - averagePrice) / mid;
  return {
    filledQuantity: filled,
    averagePrice,
    worstPrice: worst,
    unfilledQuantity: remaining,
    levelsConsumed: consumed,
    slippageBps: slip * 10_000,
  };
}

/**
 * 盘口可行量：这份订单在这个快照里最多能成交多少。
 * 现金/保证金校验用——先看市场能给多少，再看钱包付得起多少，取小。
 */
export function bookCapacity(book: OrderBookSnapshot, side: Side): number {
  const levels = side === "BUY" ? book.asks : book.bids;
  return levels.reduce((sum, l) => sum + (l.quantity > 0 ? l.quantity : 0), 0);
}
