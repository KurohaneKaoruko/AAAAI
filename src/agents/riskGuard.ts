/** 风控 Agent：SIGNAL -> ORDER_INTENT（校验 + 折算数量 + 金额截断）。 */

import type { EventBus } from "../core/eventBus.js";
import { Topic } from "../core/eventBus.js";
import type { OrderIntent, Side, Signal } from "../core/types.js";
import type { PriceBook } from "../data/marketDataService.js";
import type { PortfolioManager } from "../portfolio/portfolioManager.js";
import { RiskRules } from "../risk/rules.js";
import { getLogger } from "../core/logger.js";
import { Agent, type Subscription } from "./agent.js";

const log = getLogger("agent:risk-guard");

export class RiskGuardAgent extends Agent {
  readonly name = "risk-guard";

  constructor(
    bus: EventBus,
    private readonly rules: RiskRules,
    private readonly portfolio: PortfolioManager,
    private readonly book: PriceBook,
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
      log.info("信号被拦截 %s: %s", signal.symbol, decision.reason);
      this.bus.publish(Topic.ORDER_REJECTED, signal);
      return;
    }

    const price = this.book.last(signal.symbol);
    if (price === undefined) {
      this.bus.publish(Topic.ORDER_REJECTED, signal);
      return;
    }

    const position = this.portfolio.position(signal.symbol);
    const currentValue = position ? position.quantity * price : 0;
    const targetValue = signal.targetWeight * equity;
    const deltaValue = this.rules.clampDeltaValue(targetValue - currentValue);

    // 调仓金额不足 1 个单位则跳过，避免噪声单
    if (Math.abs(deltaValue) < price) return;

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
