/** 组合管理：现金、持仓、权益曲线、回撤统计。 */

import { EventBus, Topic } from "../core/eventBus.js";
import type {
  Bar,
  EquityPoint,
  Fill,
  OrderIntent,
  PortfolioMetrics,
  PortfolioSnapshot,
  Position,
} from "../core/types.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("portfolio");

export class PortfolioManager {
  cash: number;
  private positions = new Map<string, Position>();
  private prices = new Map<string, number>();
  private curve: EquityPoint[] = [];
  private peak: number;
  private fills = 0;

  constructor(
    private readonly bus: EventBus,
    initialCash: number,
  ) {
    this.cash = initialCash;
    this.peak = initialCash;
    bus.subscribe<Bar>(Topic.BAR, (e) => this.onBar(e.payload));
    bus.subscribe<Fill>(Topic.FILL, (e) => this.onFill(e.payload));
  }

  private onBar(bar: Bar): void {
    this.prices.set(bar.symbol, bar.close);
    this.curve.push({ timestamp: bar.timestamp.toISOString(), equity: round(this.equity()) });
    if (this.curve.length > 5000) this.curve.shift();
  }

  private onFill(fill: Fill): void {
    const { order } = fill;
    const pos = this.positions.get(order.symbol) ?? { symbol: order.symbol, quantity: 0, avgCost: 0 };
    const signed = order.side === "BUY" ? order.quantity : -order.quantity;
    const notional = Math.abs(signed) * fill.price;
    this.cash += (order.side === "BUY" ? -notional : notional) - fill.fee;

    const newQty = pos.quantity + signed;
    if (Math.abs(newQty) < 1e-9) {
      this.positions.delete(order.symbol);
    } else {
      const sameDirection = pos.quantity === 0 || Math.sign(pos.quantity) === Math.sign(signed);
      if (sameDirection) {
        const total = Math.abs(pos.quantity) * pos.avgCost + Math.abs(signed) * fill.price;
        pos.avgCost = total / Math.abs(newQty);
      } else {
        pos.avgCost = fill.price;
      }
      pos.quantity = newQty;
      this.positions.set(order.symbol, pos);
    }
    this.fills += 1;
    log.debug(
      "成交 %s %s %.6f @ %.4f (fee %.4f)",
      order.side,
      order.symbol,
      order.quantity,
      fill.price,
      fill.fee,
    );
  }

  position(symbol: string): Position | undefined {
    return this.positions.get(symbol);
  }

  positionsSnapshot(): Position[] {
    return [...this.positions.values()];
  }

  price(symbol: string): number | undefined {
    return this.prices.get(symbol);
  }

  equity(): number {
    let total = this.cash;
    for (const [symbol, pos] of this.positions) {
      const price = this.prices.get(symbol) ?? pos.avgCost;
      total += pos.quantity * price;
    }
    return total;
  }

  /** 当前回撤比例（相对历史峰值）。 */
  get drawdownPct(): number {
    const eq = this.equity();
    this.peak = Math.max(this.peak, eq);
    if (this.peak <= 0) return 0;
    return Math.max(0, (this.peak - eq) / this.peak);
  }

  equityCurve(): EquityPoint[] {
    return [...this.curve];
  }

  snapshot(): PortfolioSnapshot {
    return {
      timestamp: new Date(),
      cash: this.cash,
      positions: Object.fromEntries(this.positions),
    };
  }

  metrics(): PortfolioMetrics {
    return {
      finalEquity: round(this.equity(), 4),
      cash: round(this.cash, 4),
      openPositions: this.positions.size,
      totalFills: this.fills,
      maxDrawdownPct: round(this.drawdownPct, 6),
      equityPoints: this.curve.length,
    };
  }
}

function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
