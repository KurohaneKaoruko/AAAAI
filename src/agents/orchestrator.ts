/**
 * 装配层：把连接（行情源）、Agent、策略、风控、券商、组合连成一条流水线。
 */

import { EventBus, Topic } from "../core/eventBus.js";
import type { Bar, OrderIntent } from "../core/types.js";
import { PriceBook, streamBars } from "../data/streaming.js";
import type { Broker } from "../execution/broker.js";
import { PaperBroker } from "../execution/paperBroker.js";
import { ExchangeBroker } from "../execution/exchangeBroker.js";
import type { ExchangeAdapter } from "../exchanges/types.js";
import { MarketAnalystAgent } from "./marketAnalyst.js";
import { RiskGuardAgent } from "./riskGuard.js";
import { StrategistAgent } from "./strategist.js";
import { AllocatorAgent } from "./allocatorAgent.js";
import { AIAllocator, CrossSectionalAllocator } from "../strategies/allocator.js";
import { PortfolioManager } from "../portfolio/portfolioManager.js";
import { RiskRules } from "../risk/rules.js";
import { MomentumStrategy } from "../strategies/momentum.js";
import { LLMStrategy } from "../strategies/llmStrategy.js";
import type { Strategy } from "../strategies/strategy.js";
import type { LLMClient } from "../llm/llmClient.js";
import { resolveDecisionLanes, type AppConfig, type DecisionSource } from "../configSchema.js";
import { BlendedAllocator, BlendedStrategy, type Lane } from "../strategies/blend.js";
import { JointAllocator, JointStrategy } from "../strategies/joint.js";

export interface PipelineOptions {
  /** 行情/交易适配器 */
  adapter: ExchangeAdapter;
  /** true = 真实下单（需适配器支持且已配 Key） */
  liveTrading: boolean;
  /** LLM 客户端（多实例负载均衡时为 LlmManager）；null = 纯规则模式 */
  llm?: LLMClient | null;
  /**
   * 混合决策：每一路决策各一个客户端（chat / systemone），缺省表示该路没有可用实例。
   * 不传时退回单路：按 strategy.sources[0] 使用 options.llm。
   */
  lanes?: Partial<Record<DecisionSource, LLMClient | null>>;
}

export interface Pipeline {
  bus: EventBus;
  book: PriceBook;
  portfolio: PortfolioManager;
  broker: Broker;
  strategy: Strategy;
  /** 资产配置器（开启 self_allocating 时非空） */
  allocator: AllocatorAgent | null;
}

export function buildPipeline(config: AppConfig, options: PipelineOptions): Pipeline {
  const bus = new EventBus();
  const book = new PriceBook();
  const portfolio = new PortfolioManager(bus, config.risk.initialCash);

  const momentum = new MomentumStrategy(
    config.strategy.fastWindow,
    config.strategy.slowWindow,
    config.strategy.maxTargetWeight,
  );

  // 决策路：rules 恒可用；模型路看有没有可用实例（没配就自动退出，配比让给其余路）。
  const clientOf = (source: DecisionSource): LLMClient | null => {
    if (source === "rules") return null;
    return options.lanes?.[source] ?? (resolveDecisionLanes(config.strategy).sources[0] === source ? (options.llm ?? null) : null);
  };
  const { sources, blend } = resolveDecisionLanes(config.strategy);
  const lanes: Lane[] = sources.map((source) => ({
    source,
    weight: blend[source],
    available: source === "rules" || Boolean(clientOf(source)),
  }));
  const activeLanes = lanes.filter((l) => l.weight > 0 && l.available);

  const llmStrategyFor = (source: DecisionSource): Strategy => {
    const client = clientOf(source);
    return client ? new LLMStrategy(momentum, client, config.llm.decisionInterval) : momentum;
  };
  const perSourceStrategy: Partial<Record<DecisionSource, Strategy>> = {
    rules: momentum,
    chat: llmStrategyFor("chat"),
    systemone: llmStrategyFor("systemone"),
  };

  // 对话模型 + System One 同时在线时走「联合决策」：两路互相知情地前后手出主意，
  // 而不是各算各的再平均；只有一路模型时才用普通融合或单路。
  const chatOn = lanes.find((l) => l.source === "chat")?.available && blend.chat > 0;
  const soOn = lanes.find((l) => l.source === "systemone")?.available && blend.systemone > 0;
  const joint = chatOn && soOn;

  const strategy: Strategy = joint
    ? new JointStrategy(
        perSourceStrategy.chat ?? null,
        perSourceStrategy.systemone ?? null,
        blend,
        momentum.warmup,
      )
    : activeLanes.length > 1
      ? new BlendedStrategy(lanes, perSourceStrategy)
      : (perSourceStrategy[activeLanes[0]?.source ?? sources[0]!] ?? momentum);

  // 点评用第一个可用的模型（没有就纯规则，不影响主流程）
  const commentaryLlm = lanes.map((l) => clientOf(l.source)).find((c): c is LLMClient => Boolean(c)) ?? null;

  new MarketAnalystAgent(bus, 3, 10, commentaryLlm).attach();

  // 资产配置模式：AI/规则在候选池里自己选标的配权重，逐标的仓位决策不再介入；
  // 关闭时仍是原来的「每个标的一个信号」。
  let allocator: AllocatorAgent | null = null;
  if (config.strategy.selfAllocating) {
    const limits = {
      maxPositions: config.strategy.maxPositions,
      maxPositionWeight: config.risk.maxPositionWeight,
      grossCap: config.strategy.maxGrossExposure,
    };
    allocator = new AllocatorAgent(bus, {
      fastWindow: config.strategy.fastWindow,
      slowWindow: config.strategy.slowWindow,
      interval: config.strategy.allocationInterval,
      warmup: config.strategy.slowWindow,
      limits,
      allocator: joint
        ? new JointAllocator(
            {
              chat: new AIAllocator(new CrossSectionalAllocator(), clientOf("chat"), limits),
              systemone: new AIAllocator(new CrossSectionalAllocator(), clientOf("systemone"), limits),
              blend,
            },
            limits,
          )
        : new BlendedAllocator(
            lanes,
            {
              rules: new AIAllocator(new CrossSectionalAllocator(), null, limits),
              chat: new AIAllocator(new CrossSectionalAllocator(), clientOf("chat"), limits),
              systemone: new AIAllocator(new CrossSectionalAllocator(), clientOf("systemone"), limits),
            },
            limits,
          ),
      portfolio,
    });
    allocator.attach();
  } else {
    new StrategistAgent(bus, strategy, commentaryLlm).attach();
  }
  new RiskGuardAgent(
    bus,
    new RiskRules({
      maxPositionWeight: config.risk.maxPositionWeight,
      maxOrderValue: config.risk.maxOrderValue,
      maxDrawdownPct: config.risk.maxDrawdownPct,
      minTradeValue: config.risk.minTradeValue,
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

  return { bus, book, portfolio, broker, strategy, allocator };
}

/**
 * 把行情喂进流水线。
 *
 * 必须用这条：策略/风控等 Agent 挂在 pipeline.bus 上、风控持有 pipeline.book。
 * 若另建 EventBus / PriceBook，事件会无人接收或风控因「查不到价格」拒掉全部信号，
 * 表现为「跑完了但一单没成」。请统一调用本函数。
 */
export async function feed(pipeline: Pipeline, bars: Bar[]): Promise<void> {
  if (bars.length === 0) return;
  await streamBars(pipeline.bus, pipeline.book, bars);
}
