/**
 * 装配层：把连接（行情源）、Agent、策略、风控、券商、组合连成一条流水线。
 */

import { EventBus, Topic } from "../core/eventBus.js";
import type { OrderIntent } from "../core/types.js";
import { PriceBook } from "../data/streaming.js";
import type { Broker } from "../execution/broker.js";
import { PaperBroker } from "../execution/paperBroker.js";
import { ExchangeBroker } from "../execution/exchangeBroker.js";
import type { ExchangeAdapter } from "../exchanges/types.js";
import { MarketAnalystAgent } from "./marketAnalyst.js";
import { RiskGuardAgent } from "./riskGuard.js";
import { StrategistAgent } from "./strategist.js";
import { PortfolioManager } from "../portfolio/portfolioManager.js";
import { RiskRules } from "../risk/rules.js";
import { MomentumStrategy } from "../strategies/momentum.js";
import { LLMStrategy } from "../strategies/llmStrategy.js";
import type { Strategy } from "../strategies/strategy.js";
import type { LLMClient } from "../llm/llmClient.js";
import type { AppConfig } from "../configSchema.js";

export interface PipelineOptions {
  /** 行情/交易适配器 */
  adapter: ExchangeAdapter;
  /** true = 真实下单（需适配器支持且已配 Key） */
  liveTrading: boolean;
  /** LLM 客户端（多实例负载均衡时为 LlmManager）；null = 纯规则模式 */
  llm?: LLMClient | null;
}

export interface Pipeline {
  bus: EventBus;
  book: PriceBook;
  portfolio: PortfolioManager;
  broker: Broker;
  strategy: Strategy;
}

export function buildPipeline(config: AppConfig, options: PipelineOptions): Pipeline {
  const bus = new EventBus();
  const book = new PriceBook();
  const portfolio = new PortfolioManager(bus, config.risk.initialCash);

  const llm = config.strategy.decisionSource === "rules" ? null : (options.llm ?? null);
  const momentum = new MomentumStrategy(
    config.strategy.fastWindow,
    config.strategy.slowWindow,
    config.strategy.maxTargetWeight,
  );
  const strategy: Strategy = llm
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
    options.liveTrading && options.adapter.placeOrder
      ? new ExchangeBroker(bus, options.adapter)
      : new PaperBroker(bus, book, {
          feeRate: config.risk.feeRate,
          slippageBps: config.risk.slippageBps,
        });

  // 执行层接入总线：订单意图 -> 券商 -> 成交广播
  bus.subscribe<OrderIntent>(Topic.ORDER_INTENT, async (e) => {
    await broker.handle(e.payload);
  });

  return { bus, book, portfolio, broker, strategy };
}
