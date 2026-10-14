/** 模拟券商：按最新价 ± 滑点立即成交，收取手续费。 */

import { EventBus, Topic } from "../core/eventBus.js";
import type { Fill, OrderIntent } from "../core/types.js";
import type { Broker } from "./broker.js";
import type { PriceBook } from "../data/marketDataService.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("broker:paper");

export interface PaperBrokerOptions {
  feeRate: number;
  slippageBps: number;
}

export class PaperBroker implements Broker {
  readonly name = "paper-broker";
  readonly paper = true;

  constructor(
    private readonly bus: EventBus,
    private readonly book: PriceBook,
    private readonly opts: PaperBrokerOptions,
  ) {
    bus.subscribe<OrderIntent>(Topic.ORDER_INTENT, async (e) => {
      await this.submit(e.payload);
    });
  }

  async submit(intent: OrderIntent): Promise<Fill | null> {
    const price = this.book.last(intent.symbol);
    if (price === undefined || !(intent.quantity > 0)) {
      log.warn("无行情或数量为 0，订单被驳回: %s", intent.symbol);
      this.bus.publish(Topic.ORDER_REJECTED, intent);
      return null;
    }
    const slip = (price * this.opts.slippageBps) / 10_000;
    const execPrice = intent.side === "BUY" ? price + slip : price - slip;
    const notional = intent.quantity * execPrice;
    const fill: Fill = {
      order: intent,
      price: execPrice,
      fee: notional * this.opts.feeRate,
      timestamp: intent.timestamp,
    };
    log.info(
      "PAPER %s %s %s @ %s",
      intent.side,
      intent.symbol,
      intent.quantity.toFixed(6),
      execPrice.toFixed(4),
    );
    this.bus.publish(Topic.FILL, fill);
    return fill;
  }
}
