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
  /**
   * 交易物由交易所自己定：用户不需要也不能挑（模拟交易所的几条走向）。
   */
  builtinSymbols?: boolean;
  /** 常用/自带交易物清单 */
  defaultSymbols?: SymbolInfo[];
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

/** 常用标的可选项（内置清单 + 尽力补上的实时价） */
export interface PopularSymbol extends SymbolInfo {
  inWatchlist: boolean;
  price: number | null;
  changePct: number | null;
}

export interface Ticker {
  symbol: string;
  price: number;
  changePct: number;
  volume: number;
  timestamp: number;
  /** 这条行情来自哪个连接（候选池行情按连接分开显示） */
  connectionId?: string;
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

export type DecisionSource = "rules" | "chat" | "systemone" | "hybrid";

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

export type RunnerKind = "baseline" | "rules" | "chat" | "systemone" | "hybrid";

/** 对照参赛者的来源：机器人 / 策略 / 模型实例 / 基线 */
export type ParticipantType = "baseline" | "bot" | "strategy" | "model";

/** 服务端摊平的参赛者：能勾哪些、为什么不能勾，都由它说了算。 */
export interface Participant {
  /** 提交给服务端的唯一键 */
  key: string;
  type: ParticipantType;
  name: string;
  detail: string;
  decisionSource: "rules" | "chat" | "systemone" | "hybrid";
  params: {
    fastWindow: number;
    slowWindow: number;
    maxTargetWeight: number;
    maxPositions: number;
    selfAllocating: boolean;
  };
  models: string[];
  /** 不能参赛的原因；为空即可参赛 */
  unavailable?: string;
}

/** 机器人只有实时一种：历史模拟（回放）在独立的「回测」页，不属于机器人。 */
export type BotMode = "live";
export type BotStatus = "idle" | "running" | "stopped" | "error";

export interface BotHolding {
  symbol: string;
  quantity: number;
  avgCost: number;
  price: number;
  marketValue: number;
  weight: number;
  unrealizedPnl: number;
}

/** 某个账号此刻的资产配置快照。 */
export interface BotAllocation {
  timestamp: string;
  equity: number;
  cash: number;
  cashWeight: number;
  holdings: BotHolding[];
  heldCount: number;
  /** 最新目标权重（symbol -> 0~1，未出现 = 0） */
  targets: Record<string, number>;
  /** 最新决策时间（无决策为 null） */
  decidedAt: string | null;
  /** 最新决策理由 */
  reason: string;
  /** 各标的最新价（行情） */
  prices: Record<string, number>;
}

/** 一条仓位调整指引：把机器人的目标仓位换算成"人可以照做"的操作。 */
export interface BotAction {
  symbol: string;
  /** BUY 加仓/建仓 · SELL 减仓/清仓 · HOLD 无需操作 */
  side: "BUY" | "SELL" | "HOLD";
  quantity: number;
  price: number;
  value: number;
  fromWeight: number;
  toWeight: number;
  holdingQty: number;
  targetQty: number;
  reason: string;
  at: string;
  note?: string;
}

/** 一次历史模拟（回测）的结果。成交一次性全出——它就是要把整段历史跑完。 */
export interface BacktestResult {
  /** real = 真实行情；simulated = 本地随机生成的演示行情（不构成任何证据） */
  marketData: "real" | "simulated";
  connectionLabel?: string;
  symbols: string[];
  interval: string;
  barCount: number;
  bars: number;
  /**
   * 随机行情的情景种子（真实行情没有）。不填则每次回测都会掷新路径；
   * 想原样重现某一次结果，把这个数填回去。
   */
  scenarioSeed?: number;
  durationMs: number;
  strategyId: string;
  strategyName: string;
  decisionSource: string;
  metrics: {
    finalEquity: number;
    cash: number;
    openPositions: number;
    totalFills: number;
    maxDrawdownPct: number;
    realizedPnl: number;
    equityPoints: number;
    totalReturn: number;
  };
  equityCurve: EquityPoint[];
  trades: TradeRecord[];
  pnlBySymbol: { symbol: string; realizedPnl: number; fills: number }[];
}

export interface BotMetrics {
  finalEquity: number;
  cash: number;
  openPositions: number;
  totalFills: number;
  maxDrawdownPct: number;
  realizedPnl: number;
  equityPoints: number;
  totalReturn: number;
}

export interface Bot {
  id: string;
  name: string;
  enabled: boolean;
  connectionId: string;
  symbols: string[];
  /** 机器人只有实时一种：决策/成交/统计都来自实时行情。历史模拟在「回测」页。 */
  mode: "live";
  interval: string;
  barCount: number;
  pollMs: number;
  decisionSource: DecisionSource;
  /** 引用的策略 id（策略列表） */
  strategyId?: string;
  modelProfileIds: string[];
  decisionInterval: number;
  /** 实时模式的成交方式：true = 模拟成交（行情真实、本地撮合），false = 真实下单 */
  paperTrading: boolean;
  strategy: {
    fastWindow: number;
    slowWindow: number;
    maxTargetWeight: number;
    selfAllocating: boolean;
    maxPositions: number;
    maxGrossExposure: number;
    allocationInterval: number;
    /** 混合决策：分析结论对决策模型的影响力（0~1） */
    hybridInfluence: number;
  };
  risk: {
    initialCash: number;
    maxPositionWeight: number;
    maxOrderValue: number;
    maxDrawdownPct: number;
    minTradeValue: number;
  };
  createdAt: string;
  modelLabels: string[];
  /** 行情来源：real = 真实行情；simulated = 模拟交易所的随机行情 */
  marketData: "real" | "simulated";
  /** 拆单执行统计（paper 券商且开了拆单时才有） */
  slicing?: {
    algo: "none" | "twap" | "vwap";
    slices: number;
    completed: number;
    pending: number;
    avgShortfallBps: number;
  };
  state: {
    id: string;
    status: BotStatus;
    /** 本次运行是否真的在发真实订单（实时模式 ≠ 实盘） */
    liveTrading: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
      metrics: BotMetrics | null;
    /** 权益曲线（尾部若干点），仪表盘用它画图 */
    equityCurve: { timestamp: string; equity: number }[];
    /** 当前资产配置（各标的权重 + 现金） */
    allocation: BotAllocation | null;
    bars: number;
    /** 预热载入的历史 K 线数（只喂指标，不产生成交） */
    warmupBars: number;
    durationMs: number;
    events: { topic: string; timestamp: string; summary: string }[];
    /** 成交流水（新->旧，尾部若干条） */
    trades: BotTrade[];
    /** 各标的的已实现盈亏合计 */
    pnlBySymbol: { symbol: string; realizedPnl: number; fills: number }[];
    /** 仓位调整指引（供人工对照实盘模仿；没有决策时为空） */
    actions: BotAction[];
  };
  /** 历史运行存档（新 -> 旧，跨重启保留） */
  history: BotRunRecord[];
  /** 历史汇总（各次已实现盈亏求和，非复利） */
  totals: BotHistoryTotals;
}

/**
 * 一次运行（start -> stop）的存档。
 * 只活在内存里的战绩重启就没，等于没有长期战绩——所以它必须落盘。
 */
export interface BotRunRecord {
  id: string;
  botId: string;
  /** 运行时的机器人名（改名后保留当时名字） */
  name: string;
  mode: BotMode;
  /** 模拟成交（true）/ 真实下单（false） */
  paperTrading: boolean;
  /** 这次运行是否真把订单发给了交易所 */
  liveTrading: boolean;
  status: "running" | "stopped" | "error";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  bars: number;
  /** 当时跑的标的 */
  symbols: string[];
  /** 当时引用的策略名 */
  strategyName: string;
  metrics: BotMetrics | null;
  equityCurve: { timestamp: string; equity: number }[];
  /** 成交流水尾部若干条（可能截断，见 tradesTruncated） */
  trades: BotTrade[];
  /** trades 是否只是尾部若干笔而非全部——界面必须据此说明 */
  tradesTruncated: boolean;
  pnlBySymbol: { symbol: string; realizedPnl: number; fills: number }[];
  error: string | null;
}

/** 历史汇总：各次运行独立从初始资金开始，累计为各次已实现盈亏之和（不是复利）。 */
export interface BotHistoryTotals {
  runs: number;
  wins: number;
  losses: number;
  cumulativeRealizedPnl: number;
  totalFills: number;
  bestReturn: number;
  worstReturn: number;
  lastRunAt: string | null;
}

/** 成交流水的一行。 */
export interface BotTrade {
  id: number;
  timestamp: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  fee: number;
  realizedPnl: number;
  reason: string;
}

/** 策略列表里的一条（服务端 src/strategies/profileStore.ts 的实体）。 */
export interface StrategyProfile {
  id: string;
  name: string;
  note?: string;
  decisionSource: DecisionSource;
  fastWindow: number;
  slowWindow: number;
  maxTargetWeight: number;
  selfAllocating: boolean;
  maxPositions: number;
  maxGrossExposure: number;
  allocationInterval: number;
  hybridInfluence: number;
  hybridAnalysisTtlMs: number;
  createdAt: string;
}

export interface BotInput {
  name: string;
  connectionId: string;
  symbols: string[];
  interval?: string;
  barCount?: number;
  pollMs?: number;
  decisionSource?: DecisionSource;
  /** 引用策略列表里的一条 */
  strategyId?: string;
  modelProfileIds?: string[];
  decisionInterval?: number;
  /** 实时模式的成交方式：true = 模拟成交（默认），false = 真实下单 */
  paperTrading?: boolean;
  strategy?: {
    fastWindow?: number;
    slowWindow?: number;
    maxTargetWeight?: number;
    selfAllocating?: boolean;
    maxPositions?: number;
    maxGrossExposure?: number;
    allocationInterval?: number;
    hybridInfluence?: number;
  };
  risk?: {
    initialCash?: number;
    maxPositionWeight?: number;
    maxOrderValue?: number;
    maxDrawdownPct?: number;
    minTradeValue?: number;
  };
  enabled?: boolean;
}

export interface RunnerResult {
  id: string;
  label: string;
  kind: RunnerKind;
  decisionSource: "rules" | "chat" | "systemone" | "hybrid";
  /** 实际生效的策略参数（页面摊开给用户核对） */
  params: Record<string, number | boolean | string>;
  origin?: { type: ParticipantType; key: string; name: string };
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
  /** real = 真实行情；simulated = 本地随机行情（名次只在这条随机路径上成立） */
  marketData: "real" | "simulated";
  connectionLabel?: string;
  symbols: string[];
  bars: number;
  /** 随机行情的情景种子（真实行情没有）：所有参赛者共用的那一条路径 */
  scenarioSeed?: number;
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
    provider: string;
    baseUrl: string;
    apiKeyEnv: string;
    apiKey: string;
    model: string;
    temperature: number;
    timeoutMs: number;
    decisionInterval: number;
    strategy: BalanceStrategy;
  /** 大模型工具能力 */
  agentEnabled: boolean;
  agentMaxSteps: number;
  };
  strategy: {
    decisionSource: DecisionSource;
    name: string;
    fastWindow: number;
    slowWindow: number;
    maxTargetWeight: number;
    /** AI 在候选池里自行选资产并配权重 */
    selfAllocating: boolean;
    maxPositions: number;
    maxGrossExposure: number;
    allocationInterval: number;
    /** 混合决策：分析结论对决策模型的影响力（0~1） */
    hybridInfluence: number;
    hybridAnalysisTtlMs: number;
  };
  risk: {
    initialCash: number;
    feeRate: number;
    slippageBps: number;
    maxOrderValue: number;
    maxPositionWeight: number;
    maxDrawdownPct: number;
    minTradeValue: number;
  };
  llmTooling?: {
    agentEnabled: boolean;
    agentMaxSteps: number;
  };
  news: NewsSection;
  evolution: EvolutionSection;
  optimize: OptimizeSection;
  cost: CostSection;
  execution: {
    mode: "paper" | "live";
    connectionId: string;
    slicingAlgo: "none" | "twap" | "vwap";
    slicingSlices: number;
    slicingSpacingBars: number;
    slicingVolumeProfileBars: number;
  };
  auth: { enabled: boolean; username: string; sessionTtlHours: number };
}

/**
 * 全局状态：只有配置、候选池行情、模拟对照。
 * 运行相关的数据都在机器人那边（/api/bots）—— 单账户引擎已删除。
 */
export interface EngineState {
  tickers: Ticker[];
  comparison: ComparisonResult | null;
  comparing: boolean;
  config: AppConfig;
  /** "现在开跑会跑什么"：服务端按连接解析后的真实标的（前端不要自己猜） */
  runTarget: {
    connectionId: string | null;
    connectionLabel: string | null;
    /** 适配器 id（simulated = 随机行情），界面据此标注 */
    connectionAdapterId: string | null;
    interval: string;
    symbols: string[];
    error: string | null;
    /** 标的由交易所自带（模拟交易所），界面不要展示/要求挑选 */
    symbolsBuiltIn: boolean;
  };
}

export type Broadcast = { type: "state"; data: EngineState };

export interface NewsProviderConfig {
  id: string;
  label: string;
  url: string;
  assetClass: string;
}

export interface NewsSection {
  enabled: boolean;
  providers: NewsProviderConfig[];
  maxAgeHours: number;
  maxPerSymbol: number;
  refreshMs: number;
  includeInAnalysis: boolean;
}

export interface EvolutionSection {
  enabled: boolean;
  minSamples: number;
  cooldownMs: number;
  evaluateMs: number;
  maxChangeRatio: number;
  horizonBars: number;
  persist: boolean;
  tunable: string[];
}

export interface NewsItem {
  id: string;
  symbol: string;
  title: string;
  summary: string;
  url: string;
  source: string;
  publishedAt: string;
  sentiment: number;
  sentimentLabel: "positive" | "neutral" | "negative";
  fetchedAt: string;
}

export interface NewsStatus {
  enabled: boolean;
  providers: number;
  items: number;
  lastFetchAt: string | null;
  errors: { provider: string; message: string }[];
}

export interface EvolutionStats {
  total: number;
  settled: number;
  pending: number;
  winRate: number;
  avgReturn: number;
  avgAlpha: number;
  beatRate: number;
  bestSymbol: string | null;
  bestSymbolAlpha: number;
  lastEvaluatedAt: string | null;
  cooldownUntil: string | null;
  samplesNeeded: number;
}

export interface EvolutionChange {
  at: string;
  param: string;
  before: unknown;
  after: unknown;
  reason: string;
  evidence: { settled: number; avgAlpha: number; beatRate: number };
  reverted: boolean;
}

export interface EvolutionView {
  enabled: boolean;
  stats: EvolutionStats;
  changelog: EvolutionChange[];
  recentDecisions: (DecisionRecord & { symbols: string[] })[];
  limits: {
    minSamples: number;
    cooldownMs: number;
    maxChangeRatio: number;
    horizonBars: number;
    tunable: string[];
  };
}

export interface DecisionRecord {
  id: number;
  at: string;
  owner: string;
  source: string;
  weights: Record<string, number>;
  cashWeight: number;
  confidence: number;
  reason: string;
  refPrices: Record<string, number>;
  entryBarIndex?: number;
  outcome?: {
    horizonBars: number;
    returnPct: number;
    alpha: number;
    maxAdverse: number;
    settledAt: string;
  };
}

export interface OptimizeSection {
  method: "none" | "score" | "risk_parity";
  factorWeights: Record<string, number>;
  targetVol: number;
  minPositions: number;
  /** 协方差估计：sample = 原始样本；lw = Ledoit-Wolf 收缩 */
  covariance: "sample" | "lw";
}

export interface SlicedOrderReport {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  filledQuantity: number;
  slices: number;
  slicesDone: number;
  referencePrice: number;
  averageFillPrice: number;
  fee: number;
  /** 实施短缺（bps，正 = 多付，负 = 省下） */
  shortfallBps: number;
  pending: boolean;
}

export interface CostSection {
  impactK: number;
  maxSlippageBps: number;
}
