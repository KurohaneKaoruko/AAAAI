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

/** 组合记账模式：现货现金账户 / 合约保证金账户。 */
export type PortfolioMode = "spot" | "futures";

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
    /** 缺省 spot：所有老调用保持原语义，合约模式必须显式开启 */
    private readonly mode: PortfolioMode = "spot",
  ) {
    this.cash = initialCash;
    this.peak = initialCash;
    bus.subscribe<Bar>(Topic.BAR, (e) => this.onBar(e.payload));
    bus.subscribe<Fill>(Topic.FILL, (e) => this.onFill(e.payload));
  }

  /**
   * 资金费率结算（仅合约模式；注入 fundingOf 后生效）。
   *
   * 永续合约真实账户每 8 小时按「持仓名义 × 费率」收/付资金费：
   * 正费率时多头付、空头收；负费率反过来。模拟盘不结资金费会把
   * 「长期持仓的成本」整个隐掉——策略在单边行情里赖着不动也能显得零成本。
   * provider 由上游注入（拉交易所真实费率，见适配器 fetchFundingRate），
   * 拉不到的标的按 0 处理（宁可少算也不乱编）。
   */
  setFundingProvider(fundingOf: (symbol: string) => number | null): void {
    this.fundingOf = fundingOf;
  }

  private fundingOf: ((symbol: string) => number | null) | null = null;
  /** 上次结算时刻（epoch ms）：按 8 小时对齐结算（00:00/08:00/16:00 UTC）。 */
  private lastFundingSettleMs = 0;

  /** 结算窗口内的资金费：现金直接增减，权益自然反映。返回本次结算总额（对账用）。 */
  settleFunding(nowMs: number): number {
    if (this.mode !== "futures" || !this.fundingOf) return 0;
    // 对齐 8h 网格：只有跨过下一个结算点才结（回放中多次调用安全）
    const step = 8 * 3600_000;
    const settledThrough = Math.floor(nowMs / step) * step;
    if (settledThrough <= this.lastFundingSettleMs) return 0;
    this.lastFundingSettleMs = settledThrough;
    let total = 0;
    for (const pos of this.positions.values()) {
      if (pos.quantity === 0) continue;
      const rate = this.fundingOf(pos.symbol);
      if (rate === null || rate === 0) continue;
      const price = this.prices.get(pos.symbol) ?? pos.avgCost;
      // 正费率：多头（qty>0）付出，空头（qty<0）收取 —— 与交易所口径一致
      const fee = -pos.quantity * price * rate;
      this.cash += fee;
      total += fee;
    }
    return total;
  }

  private onBar(bar: Bar): void {
    this.prices.set(bar.symbol, bar.close);
    this.curve.push({ timestamp: bar.timestamp.toISOString(), equity: round(this.equity()) });
    if (this.curve.length > 5000) this.curve.shift();
    // 每根 K 线顺带结算跨过的资金费窗口（未注入 provider 时是 no-op）
    this.settleFunding(bar.timestamp.getTime());
  }

  private onFill(fill: Fill): void {
    const { order } = fill;
    const pos = this.positions.get(order.symbol) ?? { symbol: order.symbol, quantity: 0, avgCost: 0 };
    const signed = order.side === "BUY" ? order.quantity : -order.quantity;
    const notional = Math.abs(signed) * fill.price;
    let realizedPnl = 0;
    const oldQty = pos.quantity;
    const newQty = oldQty + signed;

    if (this.mode === "spot") {
      this.cash += (order.side === "BUY" ? -notional : notional) - fill.fee;
      if (Math.abs(newQty) < 1e-9) {
        // 清仓：轧差结算
        if (order.side === "SELL") realizedPnl = (fill.price - pos.avgCost) * Math.abs(signed) - fill.fee;
        this.positions.delete(order.symbol);
      } else {
        const sameDirection = oldQty === 0 || Math.sign(oldQty) === Math.sign(signed);
        if (sameDirection) {
          // 加仓：滚动均价
          const total = Math.abs(oldQty) * pos.avgCost + Math.abs(signed) * fill.price;
          pos.avgCost = total / Math.abs(newQty);
        } else {
          // 减仓：已实现盈亏，均价不变（现金账户不允许卖穿，正常不会 flip）
          realizedPnl = (fill.price - pos.avgCost) * Math.abs(signed) - fill.fee;
        }
        pos.quantity = newQty;
        this.positions.set(order.symbol, pos);
      }
    } else {
      /**
       * 合约账户：
       * - 开仓/加仓不产生现金流，只把手续费从保证金现金里扣掉；
       * - 平仓/减仓才结算已实现盈亏（多头 = 价差，空头 = 反价差）；
       * - 反手时先结清旧仓，剩余数量按本次成交价开新仓。
       *
       * 权益 = 现金 + Σ (最新价 − 开仓均价) × 有符号数量，
       * 所以空头数量为负时，价格下跌会自然产生正权益。
       */
      this.cash -= fill.fee;
      if (Math.abs(oldQty) < 1e-9) {
        pos.avgCost = fill.price;
        pos.quantity = newQty;
        this.positions.set(order.symbol, pos);
      } else if (Math.sign(oldQty) === Math.sign(signed)) {
        const total = Math.abs(oldQty) * pos.avgCost + Math.abs(signed) * fill.price;
        pos.avgCost = total / Math.abs(newQty);
        pos.quantity = newQty;
        this.positions.set(order.symbol, pos);
      } else {
        const closeQty = Math.min(Math.abs(oldQty), Math.abs(signed));
        realizedPnl = (fill.price - pos.avgCost) * closeQty * Math.sign(oldQty);
        this.cash += realizedPnl;
        if (Math.abs(newQty) < 1e-9) {
          this.positions.delete(order.symbol);
        } else {
          // 反手：剩余仓位是本次新开的，成本就是成交价
          pos.quantity = newQty;
          if (Math.sign(newQty) !== Math.sign(oldQty)) pos.avgCost = fill.price;
          this.positions.set(order.symbol, pos);
        }
      }
    }
    this.fills += 1;
    this.tradeSeq += 1;
    // 流水里的已实现盈亏对合约是毛口径（手续费已单独从现金扣除），
    // 与现货口径的差异在界面/文档里要说明；胜率统计看价格方向。
    this.trades.push({
      id: this.tradeSeq,
      timestamp: fill.timestamp.toISOString(),
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      price: fill.price,
      fee: fill.fee,
      realizedPnl: this.mode === "futures" ? realizedPnl - (realizedPnl !== 0 ? fill.fee : 0) : realizedPnl,
      reason: order.reason ?? "",
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
      if (this.mode === "futures") {
        // 合约权益 = 保证金现金 + 未实现盈亏；不是「现金 + 名义市值」
        total += (price - pos.avgCost) * pos.quantity;
      } else {
        total += pos.quantity * price;
      }
    }
    return total;
  }

  /** 组合总名义敞口（绝对值之和）；现货合约都用它算集中度。 */
  grossExposure(): number {
    let total = 0;
    for (const [symbol, pos] of this.positions) {
      const price = this.prices.get(symbol) ?? pos.avgCost;
      total += Math.abs(pos.quantity) * price;
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
