/**
 * 回测引擎：从连接拉取多标的历史 K 线 -> 归并时间序列 -> 流水线 -> 指标。
 */

import { EventBus, Topic } from "../core/eventBus.js";
import { mergeBarsByTime } from "../data/streaming.js";
import type { EquityPoint, Position, TradeRecord } from "../core/types.js";
import type { PortfolioMetrics } from "../core/types.js";
import type { AppConfig } from "../configSchema.js";
import { buildPipeline, feed } from "../agents/orchestrator.js";
import type { Broker } from "../execution/broker.js";
import type { ExchangeAdapter } from "../exchanges/types.js";
import type { PriceBook } from "../data/streaming.js";
import type { PortfolioManager } from "../portfolio/portfolioManager.js";
import type { Strategy } from "../strategies/strategy.js";

export interface BacktestOptions {
  adapter: ExchangeAdapter;
  symbols: string[];
  bars?: number;
  interval: string;
  liveTrading: boolean;
}

export interface BacktestResult {
  symbol: string;
  symbols: string[];
  bars: number;
  metrics: PortfolioMetrics;
  equityCurve: EquityPoint[];
  positions: Position[];
  trades: TradeRecord[];
  events: number;
}

export async function runBacktest(
  config: AppConfig,
  options: BacktestOptions,
): Promise<BacktestResult> {
  const pipeline = buildPipeline(config, {
    adapter: options.adapter,
    liveTrading: options.liveTrading,
  });

  const limit = options.bars ?? config.market.barCount;
  const groups = await Promise.all(
    options.symbols.map((symbol) =>
      options.adapter.fetchKlines(symbol, options.interval, limit),
    ),
  );
  const bars = mergeBarsByTime(groups);
  await feed(pipeline, bars);

  return {
    symbol: options.symbols.join(", "),
    symbols: options.symbols,
    bars: bars.length,
    metrics: pipeline.portfolio.metrics(),
    equityCurve: pipeline.portfolio.equityCurve(),
    positions: pipeline.portfolio.positionsSnapshot(),
    trades: pipeline.portfolio.tradeHistory(),
    events: pipeline.bus.history().length,
  };
}
