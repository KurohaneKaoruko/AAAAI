/**
 * 装配层：把数据、Agent、策略、风控、执行、组合连成一条流水线。
 */

import { EventBus } from "../core/eventBus.js";
import { createDataSource } from "../data/binanceSource.js";
import type { DataSource } from "../data/dataSource.js";
import { PriceBook } from "../data/marketDataService.js";
import type { Broker } from "../execution/broker.js";
import { BinanceBroker } from "../execution/binanceBroker.js";
import { PaperBroker } from "../execution/paperBroker.js";
import { MarketAnalystAgent } from "./marketAnalyst.js";
import { RiskGuardAgent } from "./riskGuard.js";
import { StrategistAgent } from "./strategist.js";
import { PortfolioManager } from "../portfolio/portfolioManager.js";
import { RiskRules } from "../risk/rules.js";
import { MomentumStrategy } from "../strategies/momentum.js";
import { LLMStrategy } from "../strategies/llmStrategy.js";
import type { Strategy } from "../strategies/strategy.js";
import { createLLMClient } from "../llm/nullClient.js";
import type { AppConfig } from "../configSchema.js";

export interface Pipeline {
  bus: EventBus;
  book: PriceBook;
  portfolio: PortfolioManager;
  broker: Broker;
  strategy: Strategy;
  source: DataSource;
}

export function buildPipeline(config: AppConfig): Pipeline {
  const bus = new EventBus();
  const book = new PriceBook();
  const portfolio = new PortfolioManager(bus, config.risk.initialCash);

  const llm = createLLMClient(config.llm);
  const momentum = new MomentumStrategy(
    config.strategy.fastWindow,
    config.strategy.slowWindow,
    config.strategy.maxTargetWeight,
  );
  const strategy: Strategy =
    llm && config.strategy.name !== "momentum"
      ? new LLMStrategy(momentum, llm, config.llm.decisionInterval)
      : momentum;

  new MarketAnalystAgent(bus, 3, 10, llm).attach();
  new StrategistAgent(bus, strategy, llm).attach();
  new RiskGuardAgent(
    bus,
    new RiskRules({
      maxPositionWeight: config.risk.maxPositionWeight,
      maxOrderValue: config.risk.maxOrderValue,
      maxDrawdownPct: config.risk.maxDrawdownPct,
    }),
    portfolio,
    book,
  ).attach();

  const broker: Broker =
    config.execution.broker === "binance"
      ? new BinanceBroker(bus, {
          baseUrl: config.execution.baseUrl,
          apiKey: config.execution.apiKey,
          apiSecret: config.execution.apiSecret,
          dryRun: config.execution.dryRun,
        })
      : new PaperBroker(bus, book, {
          feeRate: config.risk.feeRate,
          slippageBps: config.risk.slippageBps,
        });

  const source = createDataSource(config.market.source, config.market.seed);
  return { bus, book, portfolio, broker, strategy, source };
}
