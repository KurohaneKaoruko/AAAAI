/** 测试公共工具：配置构造与 K 线构造。 */

import { buildConfig } from "../src/configSchema.js";
import type { AppConfig } from "../src/configSchema.js";
import type { Bar } from "../src/core/types.js";
import { SimulatedAdapter } from "../src/exchanges/simulated.js";
import type { ExchangeAdapter } from "../src/exchanges/types.js";

export type { AppConfig, Bar };

export function makeBars(closes: number[], symbol = "TEST"): Bar[] {
  const now = Date.now();
  return closes.map((c, i) => ({
    symbol,
    timestamp: new Date(now + i * 60_000),
    open: c,
    high: c * 1.001,
    low: c * 0.999,
    close: c,
    volume: 1,
  }));
}

/** 测试用配置：模拟交易所 + paper 券商 + 无 LLM，零外部依赖。 */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = buildConfig({
    app: { name: "TEST", log_level: "error" },
    market: { symbols: ["DEMO-BTC"], interval: "1m", bar_count: 120, poll_ms: 60_000 },
    strategy: { name: "momentum", fast_window: 5, slow_window: 20, max_target_weight: 0.5 },
    risk: {
      initial_cash: 100_000,
      fee_rate: 0.0003,
      slippage_bps: 2,
      max_order_value: 20_000,
      max_position_weight: 0.6,
      max_drawdown_pct: 0.15,
    },
    execution: { mode: "paper", connection_id: "" },
    llm: { enabled: false },
  });
  return { ...base, ...overrides };
}

/** 已 init 的模拟适配器（离线、确定性）。 */
export function testAdapter(): ExchangeAdapter {
  const adapter = new SimulatedAdapter();
  adapter.init({ apiKey: "", apiSecret: "", testnet: false });
  return adapter;
}