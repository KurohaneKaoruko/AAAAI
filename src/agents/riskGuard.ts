/** 风控 Agent：SIGNAL -> ORDER_INTENT（校验 + 折算数量 + 金额截断）。 */

import type { EventBus } from "../core/eventBus.js";
import { Topic } from "../core/eventBus.js";
import type { OrderIntent, Side, Signal } from "../core/types.js";
import type { PriceBook } from "../data/streaming.js";
import type { PortfolioManager } from "../portfolio/portfolioManager.js";
import { RiskRules } from "../risk/rules.js";
import { getLogger } from "../core/logger.js";
import { Agent, type Subscription } from "./agent.js";

const logger = getLogger("agent:risk-guard");

export class RiskGuardAgent extends Agent {
  readonly name = "risk-guard";

  constructor(
    bus: EventBus,
    private readonly rules: RiskRules,
    private readonly portfolio: PortfolioManager,
    private readonly book: PriceBook,
    /** 缺省 spot；合约模式允许负目标权重并检查总名义敞口 */
    private readonly mode: "spot" | "futures" = "spot",
  ) {
    super(bus);
  }

  protected subscriptions(): Subscription[] {
    return [{ topic: Topic.SIGNAL, handler: (e) => this.onSignal(e.payload as Signal) }];
  }

  private onSignal(signal: Signal): void {
    const equity = this.portfolio.equity();
    const decision = this.rules.check(signal, equity, this.portfolio.drawdownPct);
    if (!decision.allowed) {
      logger.info("信号被拦截 %s: %s", signal.symbol, decision.reason);
      // 拒单事件带上「为什么被拦」：光有信号本身，面板上只能说"这个信号被拒"，
      // 看不出是哪条风控拦的 —— 回撤熔断与权重越界的处理方式完全不同。
      this.bus.publish(Topic.ORDER_REJECTED, { ...signal, reason: decision.reason });
      return;
    }

    const price = this.book.last(signal.symbol);
    if (price === undefined) {
      this.bus.publish(Topic.ORDER_REJECTED, { ...signal, reason: "无行情价格，无法下单" });
      return;
    }

    const position = this.portfolio.position(signal.symbol);
    const currentValue = position ? position.quantity * price : 0;
    const targetValue = signal.targetWeight * equity;
    const rawDelta = targetValue - currentValue;

    /**
     * 再平衡死区：已有同向持仓时，微小偏差不下单。
     *
     * 没有这道闸，策略输出的「目标权重 0.5」会被当成每根 K 线都要强制对齐的锚：
     * 价格每动 1%，持仓市值就动约 maxWeight×equity×1%（50% 仓位即 500U），
     * 而权益几乎不动 —— rawDelta 稳定超过任何小死区，于是每根 K 线微调一次，
     * 策略明明说「拿住不动」，风控却每根都在交易。真实行情 200 根能多出 200 笔。
     *
     * 死区宽度按**持仓市值占比**算：偏差 < 持仓的 10%（或权益 0.5%，取小者）不动。
     * 10% 看着宽，实际语义是「仓位比例漂移到 45%~55% 区间内都不管」——
     * 对 50% 目标仓位而言这正是「拿住」的本义。方向翻转 / 建仓 / 清仓
     * （无持仓或目标为 0）不走死区，必须立即执行。
     */
    const hasPosition = Math.abs(currentValue) > 1e-9;
    const sameDirection =
      hasPosition &&
      (position!.quantity > 0 ? signal.targetWeight > 0 : signal.targetWeight < 0);
    if (sameDirection) {
      // 带宽 5 个百分点：目标 50% 时，实际权重在 45%~55% 内都不动。
      // 这正是「拿住」的本义 —— 权重漂移是价格波动的自然结果，
      // 漂移出带宽才值得花一笔手续费修正。再叠 minTradeValue 兜底。
      const drift = Math.abs(currentValue / equity - Math.abs(signal.targetWeight));
      const deadband = Math.max(0.05, this.rules.limits.minTradeValue / equity);
      if (drift < deadband) {
        return;
      }
    }

    // 低于最小调仓额：视为噪声调整，不下单
    if (!this.rules.worthTrading(rawDelta)) {
      logger.debug("调仓金额 %s 低于最小调仓额，忽略", rawDelta.toFixed(2));
      return;
    }

    let deltaValue = this.rules.clampDeltaValue(rawDelta);
    if (this.mode === "futures") {
      /**
       * 合约模式的最后一道总敞口闸：
       * 单标的上限只能防一个标的，防不住「5 个标的各 50%」叠成 2.5 倍。
       * 这里用有符号持仓算当前总名义敞口，再按本单成交后的贡献做上限裁剪。
       * 减仓/平仓不受此限制。
       */
      const gross = this.portfolio.grossExposure();
      const cap = equity * (this.rules.limits.grossCap ?? 1);
      const candidateValue = currentValue + deltaValue;
      const oldContribution = Math.abs(currentValue);
      const newContribution = Math.abs(candidateValue);
      if (newContribution > oldContribution + 1e-9) {
        const room = cap - (gross - oldContribution);
        if (!(room > 1e-9)) {
          this.bus.publish(Topic.ORDER_REJECTED, {
            ...signal,
            reason: `组合总敞口已达上限 ${(cap / equity * 100).toFixed(0)}%，拒绝继续加仓`,
          });
          return;
        }
        if (newContribution > room) {
          const clipped = Math.sign(candidateValue) * room;
          deltaValue = clipped - currentValue;
        }
      }
    } else {
      // 现货：买单最多花掉手上的现金，绝不透支
      deltaValue = this.rules.clampBuyToCash(deltaValue, this.portfolio.cash);
    }

    // 调仓金额不足 1 个报价单位则跳过，避免噪声单。
    // 不能拿「金额 < 单价」当门槛：BTC 单价 8 万时，20k 的正常订单会被误判成零碎单，
    // 表现为真实行情上永远不成交，而模拟走向（单价几百）一切正常。
    if (Math.abs(deltaValue) < 1) return;

    const side: Side = deltaValue > 0 ? "BUY" : "SELL";
    const intent: OrderIntent = {
      symbol: signal.symbol,
      side,
      quantity: Math.abs(deltaValue) / price,
      price,
      timestamp: signal.timestamp,
      reason: signal.reason,
    };
    this.bus.publish(Topic.ORDER_INTENT, intent);
  }
}
