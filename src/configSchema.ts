/**
 * 类型化配置：YAML 原始对象 -> AppConfig。
 * 密钥只从环境变量读取，绝不落配置文件。
 */

import { bool, dig, fromEnv, num, str } from "./config.js";

export interface AppSection {
  name: string;
  logLevel: string;
}

export interface ServerSection {
  port: number;
  host: string;
}

export interface MarketSection {
  /** stub = 内置确定性假数据 | binance = 币安行情 */
  source: string;
  symbols: string[];
  /** K 线间隔，如 1m / 5m / 1h */
  interval: string;
  barCount: number;
  /** live 模式轮询间隔（毫秒） */
  pollMs: number;
  seed: number;
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
}

export interface StrategySection {
  /** momentum | llm-momentum */
  name: string;
  fastWindow: number;
  slowWindow: number;
  maxTargetWeight: number;
}

export interface RiskSection {
  initialCash: number;
  feeRate: number;
  slippageBps: number;
  maxOrderValue: number;
  maxPositionWeight: number;
  maxDrawdownPct: number;
}

export interface ExecutionSection {
  /** paper = 模拟成交 | binance = 实盘下单 */
  broker: string;
  /** true = 只记录不真正下单 */
  dryRun: boolean;
  baseUrl: string;
  apiKeyEnv: string;
  apiSecretEnv: string;
  apiKey: string;
  apiSecret: string;
}

export interface AppConfig {
  app: AppSection;
  server: ServerSection;
  market: MarketSection;
  llm: LLMSection;
  strategy: StrategySection;
  risk: RiskSection;
  execution: ExecutionSection;
}

export function buildConfig(raw: Record<string, unknown>): AppConfig {
  const symbols = dig(raw, "market", "symbols", ["BTCUSDT"]);
  const llmApiKeyEnv = str(raw, ["llm", "api_key_env"], "OPENAI_API_KEY");
  const execApiKeyEnv = str(raw, ["execution", "api_key_env"], "BINANCE_API_KEY");
  const execApiSecretEnv = str(raw, ["execution", "api_secret_env"], "BINANCE_API_SECRET");

  return {
    app: {
      name: str(raw, ["app", "name"], "AAAAI"),
      logLevel: str(raw, ["app", "log_level"], "info"),
    },
    server: {
      port: num(raw, ["server", "port"], 8787),
      host: str(raw, ["server", "host"], "0.0.0.0"),
    },
    market: {
      source: str(raw, ["market", "source"], "stub"),
      symbols: Array.isArray(symbols) ? (symbols as string[]) : [String(symbols)],
      interval: str(raw, ["market", "interval"], "1m"),
      barCount: Math.max(2, num(raw, ["market", "bar_count"], 200)),
      pollMs: Math.max(1000, num(raw, ["market", "poll_ms"], 15000)),
      seed: num(raw, ["market", "seed"], 42),
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
    },
    strategy: {
      name: str(raw, ["strategy", "name"], "llm-momentum"),
      fastWindow: num(raw, ["strategy", "fast_window"], 5),
      slowWindow: num(raw, ["strategy", "slow_window"], 20),
      maxTargetWeight: num(raw, ["strategy", "max_target_weight"], 0.5),
    },
    risk: {
      initialCash: num(raw, ["risk", "initial_cash"], 100000),
      feeRate: num(raw, ["risk", "fee_rate"], 0.0003),
      slippageBps: num(raw, ["risk", "slippage_bps"], 2),
      maxOrderValue: num(raw, ["risk", "max_order_value"], 20000),
      maxPositionWeight: num(raw, ["risk", "max_position_weight"], 0.6),
      maxDrawdownPct: num(raw, ["risk", "max_drawdown_pct"], 0.15),
    },
    execution: {
      broker: str(raw, ["execution", "broker"], "paper"),
      dryRun: bool(raw, ["execution", "dry_run"], true),
      baseUrl: str(raw, ["execution", "base_url"], "https://testnet.binance.vision"),
      apiKeyEnv: execApiKeyEnv,
      apiSecretEnv: execApiSecretEnv,
      apiKey: fromEnv(execApiKeyEnv),
      apiSecret: fromEnv(execApiSecretEnv),
    },
  };
}

/** 脱敏后的配置（给 WebUI / 日志用）：Key 只显示是否已设置。 */
export function redactConfig(config: AppConfig): Record<string, unknown> {
  return {
    ...config,
    llm: { ...config.llm, apiKey: config.llm.apiKey ? "***" : "" },
    execution: { ...config.execution, apiKey: "***", apiSecret: config.execution.apiSecret ? "***" : "" },
  };
}
