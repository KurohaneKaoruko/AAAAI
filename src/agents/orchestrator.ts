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
import { AllocatorAgent, type AssetAllocator } from "./allocatorAgent.js";
import { AIAllocator, CrossSectionalAllocator } from "../strategies/allocator.js";
import { PortfolioManager } from "../portfolio/portfolioManager.js";
import { RiskRules } from "../risk/rules.js";
import { MomentumStrategy } from "../strategies/momentum.js";
import { LLMStrategy } from "../strategies/llmStrategy.js";
import type { Strategy } from "../strategies/strategy.js";
import type { LLMClient } from "../llm/llmClient.js";
import type { AppConfig, DecisionSource } from "../configSchema.js";
import type { NewsDigest, NewsItem } from "../news/types.js";
import type { ToolBox, ToolContext } from "../llm/tools.js";
import { HybridAnalyst, HybridAllocator, decideSingle, type HybridOptions } from "../strategies/hybrid.js";

export interface PipelineOptions {
  /** 行情/交易适配器 */
  adapter: ExchangeAdapter;
  /** true = 真实下单（需适配器支持且已配 Key） */
  liveTrading: boolean;
  /** 对话模型客户端池；null = 无可用对话模型 */
  llm?: LLMClient | null;
  /** System One 决策模型客户端池；null = 无可用决策模型 */
  soClient?: LLMClient | null;
  /**
   * 混合决策专用：分析端（对话模型）与决策端（System One）各一个客户端。
   * 不传时分别退回 llm / soClient。
   */
  hybrid?: { chat?: LLMClient | null; systemone?: LLMClient | null };
  /** 新闻获取器（按标的返回摘要）；不传则决策链路完全看不到新闻 */
  news?: (symbols: string[]) => Promise<NewsDigest[]>;
  /** 决策留痕（自我进化用）；不传则不记录 */
  journal?: PipelineJournal;
  /** 大模型工具能力（只读工具箱）；不传则模型只能看拼好的 prompt */
  tools?: { box: ToolBox; context: ToolContext };
}

/** 决策留痕接口：只依赖最小面，便于对照实验/测试替换实现。 */
export interface PipelineJournal {
  record(entry: {
    source: string;
    weights: Record<string, number>;
    cashWeight: number;
    confidence: number;
    reason: string;
    refPrices: Record<string, number>;
    entryBarIndex: number;
  }): void;
}

export interface Pipeline {
  bus: EventBus;
  book: PriceBook;
  portfolio: PortfolioManager;
  broker: Broker;
  strategy: Strategy;
  /** 资产配置器（开启 self_allocating 或混合决策时非空） */
  allocator: AllocatorAgent | null;
}

export function buildPipeline(
  config: AppConfig,
  options: PipelineOptions,
  /** 覆盖决策来源（对照实验用：每位选手跑自己那一路，其余路不介入） */
  sourceOverride?: DecisionSource,
): Pipeline {
  const bus = new EventBus();
  const book = new PriceBook();
  const portfolio = new PortfolioManager(bus, config.risk.initialCash);

  const source: DecisionSource = sourceOverride ?? config.strategy.decisionSource;
  const momentum = new MomentumStrategy(
    config.strategy.fastWindow,
    config.strategy.slowWindow,
    config.strategy.maxTargetWeight,
  );

  const chatClient = options.hybrid?.chat ?? options.llm ?? null;
  const soClient = options.hybrid?.systemone ?? options.soClient ?? null;
  const newsFn = options.news;
  const toolBox = options.tools?.box;
  const toolCtx = options.tools?.context;
  const agentSteps = config.llm.agentEnabled ? config.llm.agentMaxSteps : 0;
  const hybridOpts: HybridOptions = {
    influence: config.strategy.hybridInfluence,
    analysisTtlMs: config.strategy.hybridAnalysisTtlMs,
    timeoutMs: config.llm.timeoutMs,
    ...(newsFn ? { news: newsFn } : {}),
    ...(toolBox && toolCtx ? { tools: toolBox, toolContext: toolCtx, agentMaxSteps: agentSteps } : {}),
  };
  const newsProvider = newsFn ?? (async () => [] as NewsDigest[]);

  // 混合决策：大模型只做分析，决策模型拿分析做仓位决策
  const hybrid = source === "hybrid";
  const analyst = hybrid ? new HybridAnalyst(chatClient, hybridOpts) : null;

  let strategy: Strategy = momentum;
  if (source === "chat") {
    strategy = chatClient
      ? new LLMStrategy(momentum, chatClient, config.llm.decisionInterval, newsProvider, toolBox, toolCtx, agentSteps)
      : momentum;
  } else if (source === "systemone") {
    strategy = soClient
      ? new LLMStrategy(momentum, soClient, config.llm.decisionInterval, newsProvider)
      : momentum;
  }

  // 点评用第一个可用的模型（没有就纯规则，不影响主流程）
  const commentaryLlm = source === "chat" ? chatClient : source === "systemone" ? soClient : chatClient ?? soClient;
  new MarketAnalystAgent(bus, 3, 10, commentaryLlm).attach();


  const limits = {
    maxPositions: config.strategy.maxPositions,
    maxPositionWeight: config.risk.maxPositionWeight,
    grossCap: config.strategy.maxGrossExposure,
  };
  const baseline = new CrossSectionalAllocator(limits);

  // 资产配置模式（AI 自己选资产）：混合决策下由「分析 -> 决策」产出权重；
  // 其余来源仍由对应模型直接给配置建议。
  const allocating = config.strategy.selfAllocating || hybrid;
  let allocator: AllocatorAgent | null = null;
  if (allocating) {
    const assetAllocator: AssetAllocator = hybrid
      ? new HybridAllocator(analyst!, soClient, baseline, limits, hybridOpts)
      : source === "chat"
        ? new AIAllocator(baseline, chatClient, limits)
        : source === "systemone"
          ? new AIAllocator(baseline, soClient, limits)
          : baseline;

    allocator = new AllocatorAgent(bus, {
      fastWindow: config.strategy.fastWindow,
      slowWindow: config.strategy.slowWindow,
      interval: config.strategy.allocationInterval,
      warmup: config.strategy.slowWindow,
      limits,
      allocator: assetAllocator,
      // 留痕时把当时的价格一并记下，结算时才能算这段窗口的实际收益
      journal: options.journal
        ? (entry) => {
            const refPrices: Record<string, number> = {};
            for (const symbol of Object.keys(entry.weights)) {
              const price = book.last(symbol);
              if (price !== undefined) refPrices[symbol] = price;
            }
            options.journal!.record({ ...entry, refPrices });
          }
        : undefined,
      // 混合决策在逐标的模式下也走这里：分析一次，然后逐标的让决策模型定档位
      perSymbolDecide:
        hybrid && !config.strategy.selfAllocating && soClient
          ? async (snaps) => {
              const analysis = await analyst!.analyze(snaps);
              const decisions = await Promise.all(
                snaps.map((s) => decideSingle(soClient, s, analysis, hybridOpts)),
              );
              return {
                weights: Object.fromEntries(decisions.filter((d) => d.weight > 0).map((d) => [d.symbol, d.weight])),
                confidence: decisions.reduce((a, d) => a + d.confidence * d.weight, 0) / Math.max(1e-9, decisions.reduce((a, d) => a + d.weight, 0)),
                reason: analysis.summary,
              };
            }
          : undefined,
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
