/** 市场分析 Agent：BAR -> MARKET_VIEW（均线趋势 + 可选 LLM 点评）。 */

import type { EventBus } from "../core/eventBus.js";
import { Topic } from "../core/eventBus.js";
import type { Bar, MarketView } from "../core/types.js";
import type { LLMClient } from "../llm/llmClient.js";
import { getLogger } from "../core/logger.js";
import { Agent, type Subscription } from "./agent.js";

const log = getLogger("agent:analyst");

const COMMENTARY_INTERVAL = 20;

export class MarketAnalystAgent extends Agent {
  readonly name = "market-analyst";

  private closes = new Map<string, number[]>();
  private seen = new Map<string, number>();

  constructor(
    bus: EventBus,
    private readonly fast: number,
    private readonly slow: number,
    private readonly llm: LLMClient | null = null,
  ) {
    super(bus);
  }

  protected subscriptions(): Subscription[] {
    return [{ topic: Topic.BAR, handler: (e) => this.onBar(e.payload as Bar) }];
  }

  private async onBar(bar: Bar): Promise<void> {
    const window = this.closes.get(bar.symbol) ?? [];
    window.push(bar.close);
    if (window.length > this.slow) window.shift();
    this.closes.set(bar.symbol, window);
    if (window.length < this.slow) return;

    const fastMa = mean(window.slice(-this.fast));
    const slowMa = mean(window);
    const momentum = slowMa === 0 ? 0 : (fastMa - slowMa) / slowMa;
    const trend = momentum > 0.001 ? "up" : momentum < -0.001 ? "down" : "flat";

    const seen = (this.seen.get(bar.symbol) ?? 0) + 1;
    this.seen.set(bar.symbol, seen);

    const view: MarketView = {
      symbol: bar.symbol,
      timestamp: bar.timestamp,
      trend,
      momentum: round(momentum, 6),
      commentary: await this.commentary(bar, trend, momentum, seen),
    };
    log.debug("%s trend=%s momentum=%s", bar.symbol, trend, view.momentum);
    this.bus.publish(Topic.MARKET_VIEW, view);
  }

  /** LLM 点评按节流执行；失败静默降级。 */
  private async commentary(
    bar: Bar,
    trend: string,
    momentum: number,
    seen: number,
  ): Promise<string> {
    if (!this.llm || seen % COMMENTARY_INTERVAL !== 0) return `trend=${trend} momentum=${momentum.toFixed(4)}`;
    try {
      const text = await this.llm.complete(
        [
          `用一句话点评 ${bar.symbol} 当前技术面（50字以内，不要打招呼）。`,
          `趋势=${trend}，动量=${momentum.toFixed(4)}，最新价=${bar.close}。`,
        ].join("\n"),
      );
      return text.slice(0, 120);
    } catch (err) {
      log.warn("LLM 点评失败: %s", (err as Error).message);
      return `trend=${trend} momentum=${momentum.toFixed(4)}`;
    }
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round(value: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
