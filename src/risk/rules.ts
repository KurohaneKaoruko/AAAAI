/** 风控规则：信号 -> 下单意图前的最后一道闸门。 */

import type { Signal } from "../core/types.js";

export interface RiskDecision {
  allowed: boolean;
  reason: string;
}

export interface RiskLimits {
  /** 单标的仓位上限（占总权益） */
  maxPositionWeight: number;
  /** 单笔下单金额上限 */
  maxOrderValue: number;
  /** 组合回撤熔断线（0~1） */
  maxDrawdownPct: number;
  /** 最小调仓金额：低于此值直接忽略，避免频繁微调（0 = 不限制） */
  minTradeValue: number;
}

export class RiskRules {
  constructor(readonly limits: RiskLimits) {}

  /** 校验目标信号是否放行。 */
  check(signal: Signal, equity: number, drawdownPct: number): RiskDecision {
    const { maxPositionWeight, maxDrawdownPct } = this.limits;
    if (drawdownPct >= maxDrawdownPct) {
      return { allowed: false, reason: `组合回撤 ${(drawdownPct * 100).toFixed(1)}% 触发熔断` };
    }
    if (!(equity > 0)) {
      return { allowed: false, reason: "权益非正，禁止交易" };
    }
    if (!Number.isFinite(signal.targetWeight) || signal.targetWeight < 0 || signal.targetWeight > 1) {
      return { allowed: false, reason: `目标权重越界: ${signal.targetWeight}` };
    }
    if (signal.targetWeight > maxPositionWeight + 1e-9) {
      return { allowed: false, reason: `目标仓位超过上限 ${(maxPositionWeight * 100).toFixed(0)}%` };
    }
    return { allowed: true, reason: "ok" };
  }

  /** 调仓金额是否值得下单（低于最小调仓额则忽略）。 */
  worthTrading(deltaValue: number): boolean {
    if (this.limits.minTradeValue <= 0) return true;
    return Math.abs(deltaValue) >= this.limits.minTradeValue;
  }

  /** 把调仓金额截断到单笔上限内。 */
  clampDeltaValue(deltaValue: number): number {
    const cap = this.limits.maxOrderValue;
    if (Math.abs(deltaValue) > cap) return deltaValue > 0 ? cap : -cap;
    return deltaValue;
  }

  /**
   * 现金账户约束：买单最多花掉手上的现金。卖单不受影响（卖出只会回笼现金）。
   *
   * 为什么留 1%：信号在收盘算出，成交在下一根开盘，中间有滑点与手续费。
   * 全部按现金花满，成交时几乎必然差一点点。真正的兜底在券商成交时
   * （模拟券商按可用现金把买单收缩到付得起的量，零头都买不起才拒单）——
   * 这里先收缩，只是不让「注定只剩零头」的整单反反复复堆进队列。
   */
  clampBuyToCash(deltaValue: number, cash: number): number {
    if (deltaValue <= 0) return deltaValue;
    return Math.min(deltaValue, Math.max(0, cash) * 0.99);
  }
}
