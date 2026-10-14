/** 策略 Agent：MARKET_VIEW -> SIGNAL（调用可插拔 Strategy）。 */

import type { EventBus } from "../core/eventBus.js";
import { Topic } from "../core/eventBus.js";
import type { Bar, MarketView, Signal } from "../core/types.js";
import { getLogger } from "../core/logger.js";
import type { Strategy } from "../strategies/strategy.js";
import type { LLMClient } from "../llm/llmClient.js";
import { Agent, type Subscription } from "./agent.js";

const log = getLogger("agent:strategist");

const BUFFER = 200;

export class StrategistAgent extends Agent {
  readonly name = "strategist";

  private bars = new Map<string, Bar[]>();

  constructor(
    bus: EventBus,
    private readonly strategy: Strategy,
    private readonly llm: LLMClient | null = null,
  ) {
    super(bus);
  }

  protected subscriptions(): Subscription[] {
    return [
      { topic: Topic.BAR, handler: (e) => this.onBar(e.payload as Bar) },
      { topic: Topic.MARKET_VIEW, handler: (e) => void this.onMarketView(e.payload as MarketView) },
    ];
  }

  private onBar(bar: Bar): void {
    const list = this.bars.get(bar.symbol) ?? [];
    list.push(bar);
    if (list.length > BUFFER) list.shift();
    this.bars.set(bar.symbol, list);
  }

  private async onMarketView(view: MarketView): Promise<void> {
    const bars = this.bars.get(view.symbol) ?? [];
    if (bars.length < this.strategy.warmup) return;
    const signal: Signal | null = await this.strategy.generate({
      symbol: view.symbol,
      bars,
      view,
    });
    if (!signal) return;
    log.debug("signal %s weight=%s (%s)", signal.symbol, signal.targetWeight, signal.reason);
    this.bus.publish(Topic.SIGNAL, signal);
  }
}
