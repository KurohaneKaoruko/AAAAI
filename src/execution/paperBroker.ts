/**
 * 模拟券商：按最新价 ± 滑点立即成交，收取手续费。
 *
 * 滑点走冲击成本模型（随订单规模与标的波动变化），而不是一个固定 bps；
 * 没有足够行情数据时自动退回固定滑点。
 */

import { EventBus, Topic } from "../core/eventBus.js";
import type { Fill, OrderIntent } from "../core/types.js";
import type { PriceBook } from "../data/streaming.js";
import { getLogger } from "../core/logger.js";
import type { Broker } from "./broker.js";
import { CostModel, DEFAULT_IMPACT, type MarketMicroStats } from "../cost/impactModel.js";

const log = getLogger("broker:paper");

export interface PaperBrokerOptions {
  feeRate: number;
  /** 基础滑点（bps）：冲击模型的固定分量 */
  slippageBps: number;
  /** 冲击系数（0 = 只用固定滑点，保持旧行为） */
  impactK?: number;
  maxSlippageBps?: number;
}

export class PaperBroker implements Broker {
  readonly name = "paper";
  readonly paper = true;

  private readonly cost: CostModel;

  constructor(
    private readonly bus: EventBus,
    private readonly book: PriceBook,
    private readonly opts: PaperBrokerOptions,
  ) {
    this.cost = new CostModel({
      baseBps: opts.slippageBps,
      k: opts.impactK ?? 0,
      maxBps: opts.maxSlippageBps ?? DEFAULT_IMPACT.maxBps,
      windowBars: DEFAULT_IMPACT.windowBars,
    });
  }

  /** 由行情缓冲喂入的交易特征；没有它就走固定滑点。 */
  setMicroStats(getter: (symbol: string) => MarketMicroStats | undefined): void {
    this.micro = getter;
  }

  private micro: ((symbol: string) => MarketMicroStats | undefined) | null = null;

  async handle(intent: OrderIntent): Promise<Fill | null> {
    const price = this.book.last(intent.symbol);
    if (price === undefined || !(intent.quantity > 0)) {
      log.warn("无行情或数量为 0，订单被驳回: %s", intent.symbol);
      this.bus.publish(Topic.ORDER_REJECTED, intent);
      return null;
    }
    const stats = this.micro?.(intent.symbol);
    const bps = this.cost.slippageBps(intent.quantity * price, stats);
    const execPrice = this.cost.execPrice(price, intent.side, bps);
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
