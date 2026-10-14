/** 与后端 API 对齐的类型。 */

export type AssetClass = "crypto" | "stock";
export type EngineStatus = "idle" | "running" | "stopped" | "error";
export type EngineMode = "backtest" | "live";

export interface AdapterMeta {
  id: string;
  name: string;
  assetClass: AssetClass | "mixed";
  description: string;
  requiresKeys: boolean;
  supportsTrading: boolean;
  supportsTestnet: boolean;
  klineIntervals: string[];
  keyFields: { key: "apiKey" | "apiSecret"; label: string; secret: boolean; placeholder?: string }[];
  notes?: string[];
}

export interface Connection {
  id: string;
  adapterId: string;
  label: string;
  testnet: boolean;
  enabled: boolean;
  createdAt: string;
  hasKey: boolean;
  hasSecret: boolean;
  adapter: AdapterMeta;
}

export interface SymbolInfo {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  currency: string;
  lotSize: number;
  pricePrecision: number;
  qtyPrecision: number;
}

export interface Ticker {
  symbol: string;
  price: number;
  changePct: number;
  volume: number;
  timestamp: number;
}

export interface WatchItem {
  id: string;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  currency: string;
  connectionId: string;
  addedAt: string;
}

export interface Position {
  symbol: string;
  quantity: number;
  avgCost: number;
}

export interface TradeRecord {
  id: number;
  timestamp: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  fee: number;
  realizedPnl: number;
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

export type LLMSection = AppConfig["llm"];
export type RiskSection = AppConfig["risk"];
export type StrategySection = AppConfig["strategy"];

export type DecisionSource = "rules" | "chat" | "systemone";

export interface PoolCounts {
  chat: { total: number; available: number };
  systemone: { total: number; available: number };
}

export type BalanceStrategy = "round-robin" | "weighted" | "random" | "latency";

export interface LlmStats {
  calls: number;
  success: number;
  failures: number;
  consecutiveFailures: number;
  avgLatencyMs: number;
  lastLatencyMs: number;
  lastError: string;
  lastUsedAt: string;
  cooldownUntil: number;
}

export interface LlmProfile {
  id: string;
  label: string;
  kind: "chat" | "systemone";
  provider: string;
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  weight: number;
  enabled: boolean;
  createdAt: string;
  levels: string[];
  levelWeights: number[];
  instructions: string;
  hasKey: boolean;
  healthy: boolean;
  stats: LlmStats;
}

export interface LlmOverview {
  total: number;
  available: number;
  calls: number;
  success: number;
  avgLatencyMs: number;
}

export interface AuthStatus {
  authRequired: boolean;
  authenticated: boolean;
}

export type RunnerKind = "baseline" | "chat" | "systemone";

export interface RunnerResult {
  id: string;
  label: string;
  kind: RunnerKind;
  model?: string;
  ok: boolean;
  error?: string;
  initialCash: number;
  finalEquity: number;
  totalReturn: number;
  maxDrawdownPct: number;
  trades: number;
  winRate: number;
  profitFactor: number;
  realizedPnl: number;
  fillCount: number;
  equityCurve: EquityPoint[];
  positions: Position[];
  llmCalls: number;
}

export interface ComparisonResult {
  symbols: string[];
  bars: number;
  initialCash: number;
  finishedAt: string;
  durationMs: number;
  winners: string[];
  results: RunnerResult[];
}

export interface SystemOnePreset {
  id: string;
  baseUrl: string;
  model: string;
  label: string;
}

export interface AppConfig {
  app: { name: string; logLevel: string };
  server: { host: string; port: number };
  market: { symbols: string[]; interval: string; barCount: number; pollMs: number };
  llm: {
    enabled: boolean;
    provider: string;
    baseUrl: string;
    apiKeyEnv: string;
    apiKey: string;
    model: string;
    temperature: number;
    timeoutMs: number;
    decisionInterval: number;
    strategy: BalanceStrategy;
  };
  strategy: {
    decisionSource: DecisionSource;
    name: string;
    fastWindow: number;
    slowWindow: number;
    maxTargetWeight: number;
  };
  risk: {
    initialCash: number;
    feeRate: number;
    slippageBps: number;
    maxOrderValue: number;
    maxPositionWeight: number;
    maxDrawdownPct: number;
  };
  execution: { mode: "paper" | "live"; connectionId: string };
  auth: { enabled: boolean; username: string; sessionTtlHours: number };
}

export interface EngineState {
  status: EngineStatus;
  mode: EngineMode | null;
  symbols: string[];
  connectionId: string | null;
  connectionLabel: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  metrics: PortfolioMetrics | null;
  positions: Position[];
  trades: TradeRecord[];
  tickers: Ticker[];
  /** 本次运行各标的标记价 */
  prices: Record<string, number>;
  equityCurve: EquityPoint[];
  events: EngineEventLine[];
  broker: { name: string; paper: boolean } | null;
  strategy: string | null;
  realizedPnl: number;
  /** 最近一次多模型对照结果 */
  comparison: ComparisonResult | null;
  comparing: boolean;
  config: AppConfig;
}

export type Broadcast =
  | { type: "state"; data: EngineState }
  | { type: "event"; data: EngineEventLine };