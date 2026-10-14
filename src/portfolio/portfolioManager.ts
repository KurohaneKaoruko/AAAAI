/** 组合管理：现金、持仓、权益曲线、成交流水与已实现盈亏。 */

import { EventBus, Topic } from "../core/eventBus.js";
import type {
  Bar,
  EquityPoint,
  Fill,
  PortfolioMetrics,
  PortfolioSnapshot,
  Position,
  Side,
  TradeRecord,
} from "../core/types.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("portfolio");

export type { TradeRecord };

export class PortfolioManager {
  cash: number;
  private positions = new Map<string, Position>();
  private prices = new Map<string, number>();
  private curve: EquityPoint[] = [];
  private peak: number;
  private fills = 0;
  private tradeSeq = 0;
  private trades: TradeRecord[] = [];

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

    let realizedPnl = 0;
    const newQty = pos.quantity + signed;
    if (Math.abs(newQty) < 1e-9) {
      // 清仓：轧差结算
      if (order.side === "SELL") realizedPnl = (fill.price - pos.avgCost) * Math.abs(signed) - fill.fee;
      this.positions.delete(order.symbol);
    } else {
      const sameDirection = pos.quantity === 0 || Math.sign(pos.quantity) === Math.sign(signed);
      if (sameDirection) {
        // 加仓：滚动均价
        const total = Math.abs(pos.quantity) * pos.avgCost + Math.abs(signed) * fill.price;
        pos.avgCost = total / Math.abs(newQty);
      } else {
        // 减仓：已实现盈亏，均价不变
        realizedPnl = (fill.price - pos.avgCost) * Math.abs(signed) - fill.fee;
        pos.avgCost = pos.avgCost;
      }
      pos.quantity = newQty;
      this.positions.set(order.symbol, pos);
    }
    this.fills += 1;
    this.tradeSeq += 1;
    this.trades.push({
      id: this.tradeSeq,
      timestamp: fill.timestamp.toISOString(),
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      price: fill.price,
      fee: fill.fee,
      realizedPnl,
    });
    if (this.trades.length > 500) this.trades.shift();
    log.debug(
      "成交 %s %s %s @ %s",
      order.side,
      order.symbol,
      order.quantity.toFixed(6),
      fill.price.toFixed(4),
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

  /** 成交流水（新->旧）。 */
  tradeHistory(): TradeRecord[] {
    return [...this.trades].reverse();
  }

  /** 累计已实现盈亏。 */
  realizedPnl(): number {
    return this.trades.reduce((sum, t) => sum + t.realizedPnl, 0);
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
