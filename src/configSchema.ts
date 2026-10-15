/**
 * 类型化配置：YAML 原始对象 -> AppConfig。
 * 密钥只从环境变量读取，绝不落配置文件。
 */

import { bool, dig, fromEnv, num, str } from "./config.js";
import { readEnv } from "./env.js";
import { loadAuthConfig } from "./auth/auth.js";
import type { BalanceStrategy } from "./llm/llmManager.js";

const STRATEGIES = new Set<BalanceStrategy>(["round-robin", "weighted", "random", "latency"]);

const DECISION_SOURCES = new Set<DecisionSource>(["rules", "chat", "systemone", "hybrid"]);

export function safeDecisionSource(value: string): DecisionSource {
  return DECISION_SOURCES.has(value as DecisionSource) ? (value as DecisionSource) : "rules";
}

/** 因子权重：只接受因子库里存在的名字。 */
function parseFactorWeights(raw: Record<string, unknown>): Record<string, number> {
  const known = new Set(["trend", "momentum", "breakout", "reversal", "volume"]);
  const src = (raw.optimize as Record<string, unknown> | undefined)?.factor_weights;
  const out: Record<string, number> = {};
  if (src && typeof src === "object") {
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      const n = Number(v);
      if (known.has(k) && Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
}

/** 新闻源列表：允许用户自己配 URL 模板，避免写死不可达的内置源。 */
function parseNewsProviders(raw: Record<string, unknown>): NewsProviderConfig[] {
  const list = (raw.news as Record<string, unknown> | undefined)?.providers;
  if (!Array.isArray(list)) return [];
  const out: NewsProviderConfig[] = [];
  for (const item of list.slice(0, 8)) {
    const o = (item ?? {}) as Record<string, unknown>;
    const url = String(o.url ?? "").trim();
    if (!url) continue;
    out.push({
      id: String(o.id ?? `p${out.length + 1}`),
      label: String(o.label ?? o.id ?? `源${out.length + 1}`).slice(0, 40),
      url: url.slice(0, 500),
      assetClass: ["crypto", "stock", "any"].includes(String(o.asset_class))
        ? String(o.asset_class)
        : "any",
    });
  }
  return out;
}

/** 允许自我进化的参数白名单（安全起见，只开放搜索类参数）。 */
const TUNABLE_KEYS = ["strategy.fastWindow", "strategy.slowWindow", "strategy.maxTargetWeight", "risk.minTradeValue"];

function parseTunables(raw: Record<string, unknown>): string[] {
  const list = (raw.evolution as Record<string, unknown> | undefined)?.tunable;
  const valid = new Set(TUNABLE_KEYS);
  if (!Array.isArray(list)) return [...TUNABLE_KEYS];
  const out = list.map((v) => String(v)).filter((v) => valid.has(v));
  return out.length > 0 ? [...new Set(out)] : [...TUNABLE_KEYS];
}

/** 限制到 0~1。 */
function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function safeStrategy(value: string): BalanceStrategy {
  return STRATEGIES.has(value as BalanceStrategy) ? (value as BalanceStrategy) : "round-robin";
}

export interface AppSection {
  name: string;
  logLevel: string;
}

export interface ServerSection {
  port: number;
  host: string;
}

export interface MarketSection {
  /** 默认标的（为空则用自选列表） */
  symbols: string[];
  /** K 线间隔，如 1m / 5m / 1h */
  interval: string;
  barCount: number;
  /** live 模式轮询间隔（毫秒） */
  pollMs: number;
}

export interface LLMSection {
  provider: string;
  baseUrl: string;
  /** 环境变量名（默认 OPENAI_API_KEY） */
  apiKeyEnv: string;
  /** 运行时解析出的 Key，不回显到任何 API */
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  /** 每隔多少根 K 线才真正请求一次 LLM（避免限流与费用爆炸） */
  decisionInterval: number;
  /** 多实例负载均衡策略 */
  strategy: BalanceStrategy;
  /**
   * 大模型「工具能力」：允许决策模型自己调用只读工具
   * （查新闻、看走势、看当前配置…）后再决策。
   */
  agentEnabled: boolean;
  /** 单次决策允许的工具调用轮数（0 = 不给工具） */
  agentMaxSteps: number;
}

/**
 * 智能体决策来源：
 * - rules      量化交易：双均线动量本地计算，不调用任何模型
 * - chat       对话模型：大模型直接给每个标的的目标仓位
 * - systemone  决策模型：System One 逐标的定档位，档位概率换算仓位
 * - hybrid     混合决策：大模型分析行情 -> 决策模型据此定仓位（职责分离）
 */
export type DecisionSource = "rules" | "chat" | "systemone" | "hybrid";

export interface StrategySection {
  /** 决策来源（三选一），决定智能体由谁做仓位决策 */
  decisionSource: DecisionSource;
  /** momentum | llm-momentum */
  name: string;
  fastWindow: number;
  slowWindow: number;
  maxTargetWeight: number;
  /** 由 AI/规则在候选池里自行选择资产并配权重（关闭时沿用逐标的仓位决策） */
  selfAllocating: boolean;
  /** 最多同时持有几个资产 */
  maxPositions: number;
  /** 组合总仓位上限（所有权重之和），其余留现金 */
  maxGrossExposure: number;
  /** 每 N 轮行情做一次资产配置 */
  allocationInterval: number;
  /**
   * 混合决策：大模型分析结论对决策模型的影响力（0~1）。
   * 0 = 决策模型看不到分析；0.5 = 参考；1 = 以分析结论为主要依据。
   */
  hybridInfluence: number;
  /** 混合决策：分析结论的有效期（秒），期内不重复调用大模型 */
  hybridAnalysisTtlMs: number;
}

export interface OptimizeSection {
  /** none = 按因子分直接给权重；score = 分数加权；risk_parity = 分层风险平价 */
  method: "none" | "score" | "risk_parity";
  /** 因子权重（名 -> 权重），空表示用默认 */
  factorWeights: Record<string, number>;
  /** 目标年化波动率（仅 risk_parity 生效，0 = 不做波动率目标） */
  targetVol: number;
  /** 风险平价最少保留几个标的 */
  minPositions: number;
  /** 协方差估计：sample = 原始样本协方差；lw = Ledoit-Wolf 收缩（样本少时更稳） */
  covariance: "sample" | "lw";
}

export interface CostSection {
  /** 冲击成本系数：0 = 只用固定滑点 */
  impactK: number;
  /** 滑点上限（bps） */
  maxSlippageBps: number;
}

export interface RiskSection {
  initialCash: number;
  /** 最小调仓金额：低于此值不下单，避免频繁微调被手续费吃掉 */
  minTradeValue: number;
  feeRate: number;
  slippageBps: number;
  maxOrderValue: number;
  maxPositionWeight: number;
  maxDrawdownPct: number;
}

export interface NewsProviderConfig {
  id: string;
  label: string;
  /** 订阅地址模板，{symbol} 会替换为标的、{query} 替换为关键词 */
  url: string;
  /** 资产类别过滤：crypto / stock / any */
  assetClass: string;
}

export interface NewsSection {
  /** 新闻总开关：关掉后既不抓取也不注入 */
  enabled: boolean;
  providers: NewsProviderConfig[];
  /** 只要这个小时数内的新闻 */
  maxAgeHours: number;
  /** 每个标的最多保留几条 */
  maxPerSymbol: number;
  /** 抓取间隔（毫秒），避免频繁打扰新闻源 */
  refreshMs: number;
  /** 是否把新闻写进分析/点评 prompt */
  includeInAnalysis: boolean;
}

export interface EvolutionSection {
  /**
   * 总开关。自我进化会自动改策略参数，默认关闭：
   * 交易参数由系统自己改是需要显式授权的事。
   */
  enabled: boolean;
  /** 至少结算多少笔决策后才允许调参 */
  minSamples: number;
  /** 两次调参之间的冷却（毫秒） */
  cooldownMs: number;
  /** 评估间隔（毫秒） */
  evaluateMs: number;
  /** 单次调参最大变动幅度（0~1），防止一步走太远 */
  maxChangeRatio: number;
  /** 决策后的结算窗口（K 线根数） */
  horizonBars: number;
  /** 调参后是否写回配置文件（默认只改内存，页面可一键写回） */
  persist: boolean;
  /** 允许调整的参数 */
  tunable: string[];
}

export interface ExecutionSection {
  /** paper = 本地模拟成交 | live = 走交易所真实下单 */
  mode: "paper" | "live";
  /** 行情/交易使用的连接 ID（下单凭证存在连接里，不在配置文件里） */
  connectionId: string;
  /** 拆单执行：none = 一次性成交（默认，保持原有行为）| twap = 按时间等量 | vwap = 按历史量能分配 */
  slicingAlgo: "none" | "twap" | "vwap";
  /** 拆成几片（1~24，1 等价于不拆） */
  slicingSlices: number;
  /** 相邻两片间隔几根 K 线 */
  slicingSpacingBars: number;
  /** VWAP 权重所用的历史成交量窗口（根） */
  slicingVolumeProfileBars: number;
}

export interface AuthSection {
  /** 是否启用鉴权（用户名+口令 或 API Token 任一存在即启用） */
  enabled: boolean;
  username: string;
  /** 会话有效期（小时） */
  sessionTtlHours: number;
}

export interface AppConfig {
  app: AppSection;
  auth: AuthSection;
  server: ServerSection;
  market: MarketSection;
  llm: LLMSection;
  strategy: StrategySection;
  risk: RiskSection;
  news: NewsSection;
  evolution: EvolutionSection;
  optimize: OptimizeSection;
  cost: CostSection;
  execution: ExecutionSection;
}

/** 拆单算法只认这三种取值，其余一律退回 none（不拆）。 */
function parseSlicingAlgo(value: string): "none" | "twap" | "vwap" {
  const v = value.trim().toLowerCase();
  return v === "twap" || v === "vwap" ? v : "none";
}

/**
 * 构造完整配置。
 * @param env 仅用于测试注入环境变量（鉴权状态完全由环境变量决定）
 */
export function buildConfig(raw: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const symbols = dig(raw, "market", "symbols", []);
  const authEnv = loadAuthConfig(env);
  const llmApiKeyEnv = str(raw, ["llm", "api_key_env"], "OPENAI_API_KEY");

  return {
    app: {
      name: str(raw, ["app", "name"], "AAAAI"),
      logLevel: str(raw, ["app", "log_level"], "info"),
    },
    // 鉴权只由环境变量决定（密码不该进配置文件）。
    // 这里是从 AuthService 派生的**只读视图**，保证 /api/config 报告的状态
    // 与真正生效的状态一致 —— 以前写成「YAML 或有 AUTH_USERNAME 即为真」，
    // 只设了用户名没设密码时，配置里显示已启用，实际却是关闭的。
    auth: {
      enabled: authEnv.required,
      username: authEnv.username,
      sessionTtlHours: Math.round(authEnv.sessionTtlMs / 3600_000),
    },
    server: {
      port: num(raw, ["server", "port"], 8787),
      host: str(raw, ["server", "host"], "0.0.0.0"),
    },
    market: {
      symbols: Array.isArray(symbols) ? (symbols as string[]) : [],
      interval: str(raw, ["market", "interval"], "1m"),
      barCount: Math.max(2, num(raw, ["market", "bar_count"], 200)),
      pollMs: Math.max(1000, num(raw, ["market", "poll_ms"], 15000)),
    },
    llm: {
      provider: str(raw, ["llm", "provider"], "openai-compatible"),
      baseUrl: str(raw, ["llm", "base_url"], "https://api.openai.com/v1"),
      apiKeyEnv: llmApiKeyEnv,
      apiKey: fromEnv(llmApiKeyEnv),
      model: str(raw, ["llm", "model"], "gpt-4o-mini"),
      temperature: num(raw, ["llm", "temperature"], 0.2),
      timeoutMs: num(raw, ["llm", "timeout_ms"], 20000),
      decisionInterval: Math.max(1, num(raw, ["llm", "decision_interval"], 10)),
      strategy: safeStrategy(str(raw, ["llm", "strategy"], "round-robin")),
      agentEnabled: bool(raw, ["llm", "agent_enabled"], true),
      agentMaxSteps: Math.max(0, Math.min(10, Math.round(num(raw, ["llm", "agent_max_steps"], 4)))),
    },
    strategy: {
      decisionSource: safeDecisionSource(
        str(raw, ["strategy", "decision_source"], bool(raw, ["llm", "enabled"], false) ? "chat" : "rules"),
      ),
      name: str(raw, ["strategy", "name"], "llm-momentum"),
      fastWindow: num(raw, ["strategy", "fast_window"], 5),
      slowWindow: num(raw, ["strategy", "slow_window"], 20),
      maxTargetWeight: num(raw, ["strategy", "max_target_weight"], 0.5),
      // 由 AI/规则在候选池里自行选择资产并配权重（关闭时沿用逐标的仓位决策）
      selfAllocating: bool(raw, ["strategy", "self_allocating"], false),
      maxPositions: Math.max(1, Math.round(num(raw, ["strategy", "max_positions"], 3))),
      maxGrossExposure: clamp01(num(raw, ["strategy", "max_gross_exposure"], 1)),
      allocationInterval: Math.max(1, Math.round(num(raw, ["strategy", "allocation_interval"], 5))),
      hybridInfluence: clamp01(num(raw, ["strategy", "hybrid_influence"], 0.6)),
      hybridAnalysisTtlMs: Math.max(0, num(raw, ["strategy", "hybrid_analysis_ttl_ms"], 60_000)),
    },
    risk: {
      initialCash: num(raw, ["risk", "initial_cash"], 100000),
      minTradeValue: Math.max(0, num(raw, ["risk", "min_trade_value"], 0)),
      feeRate: num(raw, ["risk", "fee_rate"], 0.0003),
      slippageBps: num(raw, ["risk", "slippage_bps"], 2),
      maxOrderValue: num(raw, ["risk", "max_order_value"], 20000),
      maxPositionWeight: num(raw, ["risk", "max_position_weight"], 0.6),
      maxDrawdownPct: num(raw, ["risk", "max_drawdown_pct"], 0.15),
    },
    news: {
      enabled: bool(raw, ["news", "enabled"], false),
      providers: parseNewsProviders(raw),
      maxAgeHours: Math.max(1, num(raw, ["news", "max_age_hours"], 48)),
      maxPerSymbol: Math.max(1, Math.round(num(raw, ["news", "max_per_symbol"], 6))),
      refreshMs: Math.max(30_000, num(raw, ["news", "refresh_ms"], 300_000)),
      includeInAnalysis: bool(raw, ["news", "include_in_analysis"], true),
    },
    optimize: {
      method: (["none", "score", "risk_parity"] as const).includes(
        str(raw, ["optimize", "method"], "score") as OptimizeSection["method"],
      )
        ? (str(raw, ["optimize", "method"], "score") as OptimizeSection["method"])
        : "score",
      factorWeights: parseFactorWeights(raw),
      targetVol: Math.min(Math.max(num(raw, ["optimize", "target_vol"], 0), 0), 3),
      minPositions: Math.max(0, Math.round(num(raw, ["optimize", "min_positions"], 1))),
      covariance: str(raw, ["optimize", "covariance"], "lw") === "sample" ? "sample" : "lw",
    },
    cost: {
      impactK: Math.min(Math.max(num(raw, ["cost", "impact_k"], 0), 0), 2),
      maxSlippageBps: Math.max(1, num(raw, ["cost", "max_slippage_bps"], 200)),
    },
    evolution: {
      enabled: bool(raw, ["evolution", "enabled"], false),
      minSamples: Math.max(5, Math.round(num(raw, ["evolution", "min_samples"], 20))),
      cooldownMs: Math.max(0, num(raw, ["evolution", "cooldown_ms"], 6 * 3600_000)),
      evaluateMs: Math.max(60_000, num(raw, ["evolution", "evaluate_ms"], 1800_000)),
      maxChangeRatio: Math.min(Math.max(num(raw, ["evolution", "max_change_ratio"], 0.2), 0.05), 1),
      horizonBars: Math.max(1, Math.round(num(raw, ["evolution", "horizon_bars"], 10))),
      persist: bool(raw, ["evolution", "persist"], false),
      tunable: parseTunables(raw),
    },
    execution: {
      mode: str(raw, ["execution", "mode"], "paper") === "live" ? "live" : "paper",
      connectionId: str(raw, ["execution", "connection_id"], ""),
      slicingAlgo: parseSlicingAlgo(str(raw, ["execution", "slicing_algo"], "none")),
      slicingSlices: Math.min(Math.max(Math.round(num(raw, ["execution", "slicing_slices"], 4)), 1), 24),
      slicingSpacingBars: Math.min(Math.max(Math.round(num(raw, ["execution", "slicing_spacing_bars"], 1)), 1), 24),
      slicingVolumeProfileBars: Math.min(
        Math.max(Math.round(num(raw, ["execution", "slicing_volume_profile_bars"], 20)), 1),
        200,
      ),
    },
  };
}

/**
 * AppConfig -> 配置文件结构（snake_case，与 config/default.yaml 一致）。
 * 不含任何密钥，可安全写盘。
 */
export function serializeConfig(config: AppConfig): Record<string, unknown> {
  return {
    app: { name: config.app.name, log_level: config.app.logLevel },
    server: { host: config.server.host, port: config.server.port },
    market: {
      symbols: config.market.symbols,
      interval: config.market.interval,
      bar_count: config.market.barCount,
      poll_ms: config.market.pollMs,
    },
    llm: {
      provider: config.llm.provider,
      base_url: config.llm.baseUrl,
      api_key_env: config.llm.apiKeyEnv,
      model: config.llm.model,
      temperature: config.llm.temperature,
      timeout_ms: config.llm.timeoutMs,
      decision_interval: config.llm.decisionInterval,
      strategy: config.llm.strategy,
      agent_enabled: config.llm.agentEnabled,
      agent_max_steps: config.llm.agentMaxSteps,
    },
    strategy: {
      decision_source: config.strategy.decisionSource,
      name: config.strategy.name,
      fast_window: config.strategy.fastWindow,
      slow_window: config.strategy.slowWindow,
      max_target_weight: config.strategy.maxTargetWeight,
      self_allocating: config.strategy.selfAllocating,
      max_positions: config.strategy.maxPositions,
      max_gross_exposure: config.strategy.maxGrossExposure,
      allocation_interval: config.strategy.allocationInterval,
      hybrid_influence: config.strategy.hybridInfluence,
      hybrid_analysis_ttl_ms: config.strategy.hybridAnalysisTtlMs,
    },
    risk: {
      initial_cash: config.risk.initialCash,
      min_trade_value: config.risk.minTradeValue,
      fee_rate: config.risk.feeRate,
      slippage_bps: config.risk.slippageBps,
      max_order_value: config.risk.maxOrderValue,
      max_position_weight: config.risk.maxPositionWeight,
      max_drawdown_pct: config.risk.maxDrawdownPct,
    },
    news: {
      enabled: config.news.enabled,
      providers: config.news.providers,
      max_age_hours: config.news.maxAgeHours,
      max_per_symbol: config.news.maxPerSymbol,
      refresh_ms: config.news.refreshMs,
      include_in_analysis: config.news.includeInAnalysis,
    },
    optimize: {
      method: config.optimize.method,
      factor_weights: config.optimize.factorWeights,
      target_vol: config.optimize.targetVol,
      min_positions: config.optimize.minPositions,
      covariance: config.optimize.covariance,
    },
    cost: {
      impact_k: config.cost.impactK,
      max_slippage_bps: config.cost.maxSlippageBps,
    },
    evolution: {
      enabled: config.evolution.enabled,
      min_samples: config.evolution.minSamples,
      cooldown_ms: config.evolution.cooldownMs,
      evaluate_ms: config.evolution.evaluateMs,
      max_change_ratio: config.evolution.maxChangeRatio,
      horizon_bars: config.evolution.horizonBars,
      persist: config.evolution.persist,
      tunable: config.evolution.tunable,
    },
    execution: {
      mode: config.execution.mode,
      slicing_algo: config.execution.slicingAlgo,
      slicing_slices: config.execution.slicingSlices,
      slicing_spacing_bars: config.execution.slicingSpacingBars,
      slicing_volume_profile_bars: config.execution.slicingVolumeProfileBars,
      connection_id: config.execution.connectionId,
    },
  };
}

/** 脱敏后的配置（给 WebUI / 日志用）：Key 只显示是否已设置。 */
export function redactConfig(config: AppConfig): Record<string, unknown> {
  return {
    ...config,
    // 只有模型 Key 会出现在配置里；交易所凭证存在连接中（SecretsManager），不经过这里
    llm: { ...config.llm, apiKey: config.llm.apiKey ? "***" : "" },
  };
}
