/** 交易所券商：把下单意图路由到适配器的真实下单接口。 */

import { EventBus, Topic } from "../core/eventBus.js";
import type { Fill, OrderIntent } from "../core/types.js";
import type { ExchangeAdapter } from "../exchanges/types.js";
import { getLogger } from "../core/logger.js";
import type { Broker } from "./broker.js";

const log = getLogger("broker:live");

export class ExchangeBroker implements Broker {
  readonly name = "exchange";
  readonly paper = false;

  constructor(
    private readonly bus: EventBus,
    private readonly adapter: ExchangeAdapter,
  ) {}

  async handle(intent: OrderIntent): Promise<Fill | null> {
    if (!this.adapter.placeOrder) {
      this.bus.publish(Topic.ORDER_REJECTED, intent);
      return null;
    }
    const result = await this.adapter.placeOrder({
      symbol: intent.symbol,
      side: intent.side,
      type: "MARKET",
      quoteQty: intent.quantity * intent.price,
    });
    if (result.status !== "filled") {
      log.warn("交易所拒单 %s: %s", intent.symbol, result.message ?? "");
      this.bus.publish(Topic.ORDER_REJECTED, intent);
      return null;
    }
    const fill: Fill = {
      order: intent,
      price: result.avgPrice,
      fee: result.fee,
      timestamp: new Date(),
    };
    log.info(
      "LIVE %s %s %s @ %s",
      intent.side,
      intent.symbol,
      result.filledQty.toFixed(6),
      result.avgPrice.toFixed(4),
    );
    this.bus.publish(Topic.FILL, fill);
    return fill;
  }
}
