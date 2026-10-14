/** 领域模型：贯穿 Agent 流水线的核心类型。 */

export type Side = "BUY" | "SELL";

/** 一根 K 线（OHLCV）。 */
export interface Bar {
  symbol: string;
  /** K 线收盘时间 */
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 分析 Agent 对当前市场的解读。 */
export interface MarketView {
  symbol: string;
  timestamp: Date;
  /** up | down | flat */
  trend: string;
  /** 归一化动量（正=多头占优） */
  momentum: number;
  commentary: string;
}

/** 策略 Agent 输出的目标仓位信号。 */
export interface Signal {
  symbol: string;
  timestamp: Date;
  /** 目标仓位权重（占总权益，0~1） */
  targetWeight: number;
  confidence: number;
  reason: string;
}

/** 风控 Agent 放行后产生的下单意图。 */
export interface OrderIntent {
  symbol: string;
  side: Side;
  quantity: number;
  price: number;
  timestamp: Date;
  reason: string;
}

/** 一次成交。 */
export interface Fill {
  order: OrderIntent;
  /** 含滑点的成交价 */
  price: number;
  fee: number;
  timestamp: Date;
}

/** 单个标的持仓。 */
export interface Position {
  symbol: string;
  quantity: number;
  avgCost: number;
}

/** 一笔成交流水（含已实现盈亏）。 */
export interface TradeRecord {
  id: number;
  timestamp: string;
  symbol: string;
  side: Side;
  quantity: number;
  price: number;
  fee: number;
  /** 卖出/减仓时按均价结算的已实现盈亏；买入为 0 */
  realizedPnl: number;
  /** 触发该成交的信号理由（含 [llm] / [fallback] / systemone 标记） */
  reason: string;
}

/** 某一时刻的组合快照。 */
export interface PortfolioSnapshot {
  timestamp: Date;
  cash: number;
  positions: Record<string, Position>;
}

/** 组合层汇总指标。 */
export interface PortfolioMetrics {
  finalEquity: number;
  cash: number;
  openPositions: number;
  totalFills: number;
  maxDrawdownPct: number;
  equityPoints: number;
}

/** 权益曲线上的一点。 */
export interface EquityPoint {
  timestamp: string;
  equity: number;
}
