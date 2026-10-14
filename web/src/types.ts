/** 与后端 EngineState 对齐的视图模型。 */

export interface Position {
  symbol: string;
  quantity: number;
  avgCost: number;
}

export interface EquityPoint {
  timestamp: string;
  equity: number;
}

export interface PortfolioMetrics {
  finalEquity: number;
  cash: number;
  openPositions: number;
  totalFills: number;
  maxDrawdownPct: number;
  equityPoints: number;
}

export interface EngineEventLine {
  seq: number;
  topic: string;
  timestamp: string;
  summary: string;
}

export interface EngineConfig {
  app: { name: string; logLevel: string };
  market: { source: string; symbols: string[]; interval: string; barCount: number };
  strategy: { name: string; fastWindow: number; slowWindow: number; maxTargetWeight: number };
  risk: {
    initialCash: number;
    feeRate: number;
    slippageBps: number;
    maxOrderValue: number;
    maxPositionWeight: number;
    maxDrawdownPct: number;
  };
  execution: { broker: string; dryRun: boolean; baseUrl: string };
  llm: { enabled: boolean; model: string; apiKey: string };
}

export interface EngineState {
  status: "idle" | "running" | "stopped" | "error";
  mode: "backtest" | "live" | null;
  symbol: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  metrics: PortfolioMetrics | null;
  positions: Position[];
  prices: Record<string, number>;
  equityCurve: EquityPoint[];
  events: EngineEventLine[];
  broker: { name: string; paper: boolean } | null;
  strategy: string | null;
  config: EngineConfig;
}

export type Broadcast =
  | { type: "state"; data: EngineState }
  | { type: "event"; data: EngineEventLine };
