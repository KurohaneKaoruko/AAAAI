/** 回测引擎：历史/桩 K 线 -> 流水线 -> 指标。 */

import { streamBars } from "../data/marketDataService.js";
import type { EquityPoint, PortfolioMetrics, Position } from "../core/types.js";
import type { AppConfig } from "../configSchema.js";
import { buildPipeline } from "../agents/orchestrator.js";

export interface BacktestResult {
  symbol: string;
  bars: number;
  metrics: PortfolioMetrics;
  equityCurve: EquityPoint[];
  positions: Position[];
  events: number;
}

export interface BacktestOptions {
  symbol?: string;
  bars?: number;
}

export async function runBacktest(
  config: AppConfig,
  options: BacktestOptions = {},
): Promise<BacktestResult> {
  const pipeline = buildPipeline(config);
  const symbol = options.symbol ?? config.market.symbols[0] ?? "BTCUSDT";
  const limit = options.bars ?? config.market.barCount;

  const bars = await pipeline.source.fetchBars({
    symbol,
    limit,
    interval: config.market.interval,
  });
  await streamBars(pipeline.bus, pipeline.book, bars);

  return {
    symbol,
    bars: bars.length,
    metrics: pipeline.portfolio.metrics(),
    equityCurve: pipeline.portfolio.equityCurve(),
    positions: pipeline.portfolio.positionsSnapshot(),
    events: pipeline.bus.history().length,
  };
}
