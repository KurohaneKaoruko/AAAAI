/**
 * 币安实盘网关：HMAC-SHA256 签名的现货下单。
 *
 * 安全设计：
 * - 默认 dryRun = true，只记录、不产生真实订单；
 * - 默认 baseUrl 指向测试网 testnet.binance.vision；
 * - 只有 execution.broker === "binance" 且 dryRun === false 且配对好 Key 才会真实下单；
 * - quoteOrderQty 由 intent 折算，避免 LOT_SIZE 步长问题。
 */

import { createHmac } from "node:crypto";
import { EventBus, Topic } from "../core/eventBus.js";
import type { Fill, OrderIntent } from "../core/types.js";
import type { Broker } from "./broker.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("broker:binance");

export interface BinanceBrokerOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  dryRun: boolean;
}

export class BinanceBroker implements Broker {
  readonly name = "binance-broker";
  readonly paper: boolean;

  constructor(
    private readonly bus: EventBus,
    private readonly opts: BinanceBrokerOptions,
  ) {
    this.paper = opts.dryRun || !opts.apiKey || !opts.apiSecret;
    if (this.paper) {
      log.warn("未配置 Key 或 dryRun=true，币安网关以模拟模式运行");
    } else {
      log.warn("!!! 实盘模式已启用: %s —— 将产生真实订单 !!!", opts.baseUrl);
    }
    bus.subscribe<OrderIntent>(Topic.ORDER_INTENT, async (e) => {
      await this.submit(e.payload);
    });
  }

  async submit(intent: OrderIntent): Promise<Fill | null> {
    // 模拟模式：直接按本地簿记成交（与 PaperBroker 一致的假设）
    if (this.paper) {
      const notional = intent.quantity * intent.price;
      const fill: Fill = {
        order: intent,
        price: intent.price,
        fee: notional * 0.001,
        timestamp: intent.timestamp,
      };
      log.info(
        "BINANCE(dry) %s %s %s @ %s",
        intent.side,
        intent.symbol,
        intent.quantity.toFixed(6),
        intent.price.toFixed(4),
      );
      this.bus.publish(Topic.FILL, fill);
      return fill;
    }

    const quoteQty = (intent.quantity * intent.price).toFixed(2);
    const params = new URLSearchParams({
      symbol: intent.symbol,
      side: intent.side,
      type: "MARKET",
      quoteOrderQty: quoteQty,
      timestamp: String(Date.now()),
      recvWindow: "5000",
    });
    params.set("signature", this.sign(params.toString()));

    try {
      const res = await fetch(`${this.opts.baseUrl}/api/v3/order`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-MBX-APIKEY": this.opts.apiKey,
        },
        body: params.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as {
        code?: number;
        msg?: string;
        execQty?: string;
        cummulativeQuoteQty?: string;
      };
      if (!res.ok || data.code) {
        throw new Error(`HTTP ${res.status} ${data.msg ?? JSON.stringify(data).slice(0, 200)}`);
      }
      const qty = Number(data.execQty ?? intent.quantity);
      const notional = Number(data.cummulativeQuoteQty ?? intent.quantity * intent.price);
      const fill: Fill = {
        order: intent,
        price: notional / qty,
        fee: notional * 0.001,
        timestamp: new Date(),
      };
      log.info("BINANCE(live) %s %s %s", intent.side, intent.symbol, qty.toFixed(6));
      this.bus.publish(Topic.FILL, fill);
      return fill;
    } catch (err) {
      log.error("下单失败: %s", (err as Error).message);
      this.bus.publish(Topic.ORDER_REJECTED, intent);
      return null;
    }
  }

  private sign(query: string): string {
    return createHmac("sha256", this.opts.apiSecret).update(query).digest("hex");
  }
}
