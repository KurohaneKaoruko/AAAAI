/**
 * 类型化配置：YAML 原始对象 -> AppConfig。
 * 密钥只从环境变量读取，绝不落配置文件。
 */

import { bool, dig, fromEnv, num, str } from "./config.js";
import { readEnv } from "./env.js";
import type { BalanceStrategy } from "./llm/llmManager.js";

const STRATEGIES = new Set<BalanceStrategy>(["round-robin", "weighted", "random", "latency"]);

const DECISION_SOURCES = new Set<DecisionSource>(["rules", "chat", "systemone"]);

function safeDecisionSource(value: string): DecisionSource {
  return DECISION_SOURCES.has(value as DecisionSource) ? (value as DecisionSource) : "rules";
}

/**
 * 读取混合决策配置：
 * - decision_sources：参与决策的来源列表；缺省用 decision_source 单选；
 * - blend：各来源配比；缺省给选中项等权。
 * 返回对象会展开进 strategy 小节。
 */
function sourcesOf(
  raw: Record<string, unknown>,
  fallback: DecisionSource,
): { sources: DecisionSource[]; blend: Record<DecisionSource, number> } {
  const list = Array.isArray(raw.strategy ? (raw.strategy as Record<string, unknown>).decision_sources : undefined)
    ? ((raw.strategy as Record<string, unknown>).decision_sources as unknown[])
        .map((v) => String(v))
        .filter((v): v is DecisionSource => DECISION_SOURCES.has(v as DecisionSource))
    : [];
  const sources = list.length > 0 ? [...new Set(list)] : [fallback];

  const rawBlend = (raw.strategy as Record<string, unknown> | undefined)?.blend;
  const blend: Record<DecisionSource, number> = { rules: 0, chat: 0, systemone: 0 };
  if (rawBlend && typeof rawBlend === "object") {
    for (const key of Object.keys(blend) as DecisionSource[]) {
      const v = Number((rawBlend as Record<string, unknown>)[key]);
      if (Number.isFinite(v) && v >= 0) blend[key] = v;
    }
  }
  const anyPositive = sources.some((s) => blend[s] > 0);
  if (!anyPositive) {
    for (const s of sources) blend[s] = 1;
  }
  return { sources, blend };
}

/**
 * 归一化决策路：sources / blend / decisionSource 三者可能不同步
 * （例如只改了 decisionSource），这里以「sources 为主、decisionSource 兜底」对齐。
 * 返回的配比保证：至少一路 > 0，且 sources 之外的路权重为 0。
 */
export function resolveDecisionLanes(strategy: {
  decisionSource: DecisionSource;
  sources: DecisionSource[];
  blend: Record<DecisionSource, number>;
}): { sources: DecisionSource[]; blend: Record<DecisionSource, number> } {
  // decisionSource 不在 sources 里 -> 旧式单路配置（只改过 decision_source），
  // 此时以 decisionSource 为准，避免出现「选了 chat 但配比为 0」的诡异状态。
  if (!strategy.sources.includes(strategy.decisionSource)) {
    return {
      sources: [strategy.decisionSource],
      blend: { rules: 0, chat: 0, systemone: 0, [strategy.decisionSource]: 1 },
    };
  }

  const sources: DecisionSource[] = [];
  for (const s of [...strategy.sources, strategy.decisionSource]) {
    if (DECISION_SOURCES.has(s) && !sources.includes(s)) sources.push(s);
  }
  if (sources.length === 0) sources.push("rules");

  const blend: Record<DecisionSource, number> = { rules: 0, chat: 0, systemone: 0 };
  for (const s of sources) {
    const v = Number(strategy.blend?.[s] ?? 0);
    if (Number.isFinite(v) && v > 0) blend[s] = v;
  }
  if (sources.every((s) => blend[s] === 0)) {
    for (const s of sources) blend[s] = 1;
  }
  return { sources, blend };
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
  enabled: boolean;
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
}

/** 智能体决策来源：纯规则 / 对话模型 / System One 决策模型 */
export type DecisionSource = "rules" | "chat" | "systemone";

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
  /** 参与决策的来源（可多路 = 混合决策），至少一路 */
  sources: DecisionSource[];
  /** 各来源配比（>=0，0 = 不参与）；sources 里没有的路忽略 */
  blend: Record<DecisionSource, number>;
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

export interface ExecutionSection {
  /** paper = 本地模拟成交 | live = 走交易所真实下单 */
  mode: "paper" | "live";
  /** 行情/交易使用的连接 ID */
  connectionId: string;
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
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
  execution: ExecutionSection;
}

export function buildConfig(raw: Record<string, unknown>): AppConfig {
  const symbols = dig(raw, "market", "symbols", []);
  const llmApiKeyEnv = str(raw, ["llm", "api_key_env"], "OPENAI_API_KEY");

  return {
    app: {
      name: str(raw, ["app", "name"], "AAAAI"),
      logLevel: str(raw, ["app", "log_level"], "info"),
    },
    auth: {
      enabled: bool(raw, ["auth", "enabled"], false) || Boolean(readEnv("AUTH_USERNAME")),
      username: str(raw, ["auth", "username"], readEnv("AUTH_USERNAME")),
      sessionTtlHours: num(raw, ["auth", "session_ttl_hours"], 12),
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
      enabled: bool(raw, ["llm", "enabled"], false),
      provider: str(raw, ["llm", "provider"], "openai-compatible"),
      baseUrl: str(raw, ["llm", "base_url"], "https://api.openai.com/v1"),
      apiKeyEnv: llmApiKeyEnv,
      apiKey: fromEnv(llmApiKeyEnv),
      model: str(raw, ["llm", "model"], "gpt-4o-mini"),
      temperature: num(raw, ["llm", "temperature"], 0.2),
      timeoutMs: num(raw, ["llm", "timeout_ms"], 20000),
      decisionInterval: Math.max(1, num(raw, ["llm", "decision_interval"], 10)),
      strategy: safeStrategy(str(raw, ["llm", "strategy"], "round-robin")),
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
      ...sourcesOf(
        raw,
        safeDecisionSource(str(raw, ["strategy", "decision_source"], bool(raw, ["llm", "enabled"], false) ? "chat" : "rules")),
      ),
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
    execution: {
      mode: str(raw, ["execution", "mode"], "paper") === "live" ? "live" : "paper",
      connectionId: str(raw, ["execution", "connection_id"], ""),
      baseUrl: str(raw, ["execution", "base_url"], ""),
      apiKey: "",
      apiSecret: "",
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
    auth: {
      enabled: config.auth.enabled,
      username: config.auth.username,
      session_ttl_hours: config.auth.sessionTtlHours,
    },
    server: { host: config.server.host, port: config.server.port },
    market: {
      symbols: config.market.symbols,
      interval: config.market.interval,
      bar_count: config.market.barCount,
      poll_ms: config.market.pollMs,
    },
    llm: {
      enabled: config.llm.enabled,
      provider: config.llm.provider,
      base_url: config.llm.baseUrl,
      api_key_env: config.llm.apiKeyEnv,
      model: config.llm.model,
      temperature: config.llm.temperature,
      timeout_ms: config.llm.timeoutMs,
      decision_interval: config.llm.decisionInterval,
      strategy: config.llm.strategy,
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
      decision_sources: config.strategy.sources,
      blend: config.strategy.blend,
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
    execution: {
      mode: config.execution.mode,
      connection_id: config.execution.connectionId,
    },
  };
}

/** 脱敏后的配置（给 WebUI / 日志用）：Key 只显示是否已设置。 */
export function redactConfig(config: AppConfig): Record<string, unknown> {
  return {
    ...config,
    llm: { ...config.llm, apiKey: config.llm.apiKey ? "***" : "" },
    execution: { ...config.execution, apiKey: "", apiSecret: "" },
  };
}
