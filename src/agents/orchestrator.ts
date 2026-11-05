/**
 * 装配层：把连接（行情源）、Agent、策略、风控、券商、组合连成一条流水线。
 */

import { EventBus, Topic } from "../core/eventBus.js";
import type { Bar, OrderIntent } from "../core/types.js";
import { PriceBook, streamBars } from "../data/streaming.js";
import { sandboxIdle } from "../strategies/customSandbox.js";
import type { Broker } from "../execution/broker.js";
import { PaperBroker } from "../execution/paperBroker.js";
import { ExchangeBroker } from "../execution/exchangeBroker.js";
import type { ExchangeAdapter } from "../exchanges/types.js";
import { tradingModeOf } from "../exchanges/types.js";
import { MarketAnalystAgent } from "./marketAnalyst.js";
import { RiskGuardAgent } from "./riskGuard.js";
import { StrategistAgent } from "./strategist.js";
import { AllocatorAgent, type AssetAllocator } from "./allocatorAgent.js";
import { CrossSectionalAllocator } from "../strategies/allocator.js";
import { AIAllocator, type AllocationResult } from "../strategies/allocator.js";
import type { AssetSnapshot } from "../llm/allocation.js";
import { allocateByFactors, riskTiltWeights, type OptimizeSettings } from "../strategies/factorAllocator.js";
import type { OptimizeConstraints } from "../portfolio/optimizer.js";
import type { FactorInput } from "../factors/index.js";
import { PortfolioManager } from "../portfolio/portfolioManager.js";
import { RiskRules } from "../risk/rules.js";
import { MomentumStrategy } from "../strategies/momentum.js";
import { AdaptiveTrendStrategy } from "../strategies/adaptiveTrend.js";
import { BreakoutStrategy } from "../strategies/breakout.js";
import { MeanReversionStrategy } from "../strategies/meanReversion.js";
import { CustomStrategy } from "../strategies/customStrategy.js";
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
  /** 研究/测试用：直接指定规则策略，跳过按 config.strategy.engine 装配 */
  strategyOverride?: Strategy;
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
  /**
   * 预热开关：true 时 K 线只进各 Agent 的缓冲区（指标该有的历史都有），
   * 但**不决策、不下单、不留痕**。
   *
   * 为什么需要：实时机器人的统计必须来自它实时接到的每一根新 K 线。
   * 若把一大段历史直接灌进流水线，启动瞬间就会产生几十笔"历史成交"——
   * 那是回放，不是这个机器人在实时的作为，统计也就不可能用来衡量它的实时表现。
   */
  primeMode: boolean;
}

export function buildPipeline(
  config: AppConfig,
  options: PipelineOptions,
  /** 覆盖决策来源（对照实验用：每位选手跑自己那一路，其余路不介入） */
  sourceOverride?: DecisionSource,
): Pipeline {
  const bus = new EventBus();
  const book = new PriceBook();
  const tradingMode = tradingModeOf(options.adapter);
  const portfolio = new PortfolioManager(bus, config.risk.initialCash, tradingMode);

  /*
   * 券商必须先于所有 agents 订阅 BAR：每根 K 线的派发顺序是
   * 「组合更新 -> 券商按本根开盘撮合上一轮订单 -> agents 用本根收盘决策」。
   * 若券商挂在 agents 之后，同一根里 agents 会先发出新订单并作废旧单，
   * 撮合时钟永远轮不到旧单成交 —— 决策每根都在变时（如横截面配置），
   * 订单无限互换、一单都成不了。先撮合后决策，才符合真实时间线。
   */
  const broker: Broker =
    options.liveTrading && options.adapter.placeOrder
      ? new ExchangeBroker(bus, options.adapter)
      : new PaperBroker(bus, book, {
          feeRate: config.risk.feeRate,
          slippageBps: config.risk.slippageBps,
          impactK: config.cost.impactK,
          maxSlippageBps: config.cost.maxSlippageBps,
          interval: config.market.interval,
          // 现货：模拟成交与真实券商同一道底线 —— 花不起的钱买不了。
          // 合约：开仓不占用全额现金，靠 RiskGuard 的总名义敞口上限兜底；
          // 绝不能把现货的“现金不足”逻辑套到合约上，否则空单和保证金交易全被拒。
          ...(tradingMode === "spot" ? { availableCash: () => portfolio.cash } : {}),
          slicing: {
            algo: config.execution.slicingAlgo,
            slices: config.execution.slicingSlices,
            sliceSpacingBars: config.execution.slicingSpacingBars,
            volumeProfileBars: config.execution.slicingVolumeProfileBars,
          },
        });

  // 执行层接入总线：订单意图 -> 券商 -> 成交广播。
  // 预热期（primeMode）一律不发单：历史只用来喂指标，不产生成交。
  bus.subscribe<OrderIntent>(Topic.ORDER_INTENT, async (e) => {
    if (prime.mode) return;
    await broker.handle(e.payload);
  });

  const source: DecisionSource = sourceOverride ?? config.strategy.decisionSource;
  /*
   * 做空口径：只要是合约连接就允许做空（与 engineController.tryStrategyCode 的
   * 试跑口径一致）。策略里的 allowShort 开关只对现货有约束力 —— 现货本来就不能
   * 开空（RiskRules 按 spot 拒绝负权重），开着也没意义；合约是双向市场，
   * 强制单边反而让回测与实盘互相矛盾（同一策略回测不做空、实盘做空）。
   */
  const allowShort = tradingMode === "futures";
  /** 纯规则基线：模型决策失败时也回退到同一条引擎，避免“换了模型却偷偷换策略”。 */
  const baseStrategy: Strategy =
    options.strategyOverride ?? buildRuleStrategy(config.strategy, allowShort);

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

  let strategy: Strategy = baseStrategy;
  if (source === "chat") {
    strategy = chatClient
      ? new LLMStrategy(baseStrategy, chatClient, config.llm.decisionInterval, newsProvider, toolBox, toolCtx, agentSteps)
      : baseStrategy;
  } else if (source === "systemone") {
    strategy = soClient
      ? new LLMStrategy(baseStrategy, soClient, config.llm.decisionInterval, newsProvider)
      : baseStrategy;
  }

  // 点评用第一个可用的模型（没有就纯规则，不影响主流程）
  const commentaryLlm = source === "chat" ? chatClient : source === "systemone" ? soClient : chatClient ?? soClient;
  /*
   * MarketAnalystAgent 必须晚于决策 Agent（Strategist/Allocator）挂载：
   * EventBus 按订阅顺序派发 BAR，分析 Agent 先订阅的话，它会在决策 Agent
   * 把当前 K 线写入缓冲**之前**就发布 MARKET_VIEW —— 策略拿到的 bars 不含
   * 当前这根，信号时间戳被迫落在 t-1；而撮合守卫要求「成交 bar 时间 > 信号时间」，
   * 于是成交被顶到 t 的下一根（t+1），比文档承诺的「下一根开盘」晚一根。
   * 挪到决策 Agent 之后：BAR 到达 → 决策缓冲先收下第 t 根 → 分析发布视图 →
   * 策略用 t 收盘决策、打 t 时间戳 → t+1 开盘成交，三个环节口径一致。
   * 撮合时钟（PaperBroker）已在更早处订阅，不受此调整影响。
   */
  const marketAnalyst = new MarketAnalystAgent(bus, 3, 10, commentaryLlm);


  const limits = {
    maxPositions: config.strategy.maxPositions,
    maxPositionWeight: config.risk.maxPositionWeight,
    grossCap: config.strategy.maxGrossExposure,
  };
  const baseline = new CrossSectionalAllocator(limits);

  const optimizeSettings: OptimizeSettings = {
    method: config.optimize.method,
    factorWeights: config.optimize.factorWeights,
    targetVol: config.optimize.targetVol,
    minPositions: config.optimize.minPositions,
    covariance: config.optimize.covariance,
  };
  const optConstraints: OptimizeConstraints = {
    maxPositionWeight: config.risk.maxPositionWeight,
    grossCap: config.strategy.maxGrossExposure,
  };
  /** 纯规则模式：因子打分 + 可选风险平价/波动率目标 */
  const factorAllocator: AssetAllocator = {
    async allocate(inputs: AssetSnapshot[]): Promise<AllocationResult> {
      const factorInputs: FactorInput[] = inputs.map((s) => ({
        symbol: s.symbol,
        // 因子需要真实 OHLCV（摘要里只有指标），配置器会把 K 线带过来
        bars: s.ohlcv ?? [],
      }));
      if (factorInputs.every((f) => f.bars.length === 0)) {
        // 没有 K 线明细时退回动量基线（不猜、不瞎算）
        return baseline.allocate(inputs);
      }
      return allocateByFactors(factorInputs, {
        limits: optConstraints,
        optimize: optimizeSettings,
        grossCap: config.strategy.maxGrossExposure,
        // 现有持仓权重：领先优势不足时沿用现状，避免横截面排名抖动反复换仓
        currentWeights: Object.fromEntries(
          portfolio.positionsSnapshot().map((p) => [
            p.symbol,
            Math.max(0, (p.quantity * (book.last(p.symbol) ?? p.avgCost)) / Math.max(1, portfolio.equity())),
          ]),
        ),
      }).result;
    },
  };
  /** AI 配置：在模型判断之上只做风险层面倾斜，不改方向 */
  const tiltAi = async (weights: Record<string, number>, inputs: AssetSnapshot[]): Promise<Record<string, number>> =>
    riskTiltWeights(
      weights,
      inputs.map((s) => ({ symbol: s.symbol, bars: s.ohlcv ?? [] })),
      optimizeSettings,
      optConstraints,
      config.strategy.maxGrossExposure,
    );

  // 预热闸门：整条流水线共用一份开关
  const prime = { mode: false };

  // 资产配置模式（AI 自己选资产）：混合决策下由「分析 -> 决策」产出权重；
  // 其余来源仍由对应模型直接给配置建议。
  const allocating = config.strategy.selfAllocating || hybrid;
  let allocator: AllocatorAgent | null = null;
  if (allocating) {
    const assetAllocator: AssetAllocator = hybrid
      ? withRiskTilt(new HybridAllocator(analyst!, soClient, baseline, limits, hybridOpts), tiltAi)
      : source === "chat"
        ? withRiskTilt(new AIAllocator(baseline, chatClient, limits), tiltAi)
        : source === "systemone"
          ? withRiskTilt(new AIAllocator(baseline, soClient, limits), tiltAi)
          : factorAllocator;

    allocator = new AllocatorAgent(bus, {
      fastWindow: config.strategy.fastWindow,
      slowWindow: config.strategy.slowWindow,
      interval: config.strategy.allocationInterval,
      warmup: config.strategy.slowWindow,
      limits,
      allocator: assetAllocator,
      // 留痕时把当时的价格一并记下，结算时才能算这段窗口的实际收益。
      // 预热期间不留痕：那是在回放历史，不是这台机器人的实时决策。
      journal: options.journal
        ? (entry) => {
            if (prime.mode) return;
            const refPrices: Record<string, number> = {};
            for (const symbol of Object.keys(entry.weights)) {
              const price = book.last(symbol);
              if (price !== undefined) refPrices[symbol] = price;
            }
            options.journal!.record({ ...entry, refPrices });
          }
        : undefined,
      // 预热闸门：与 ORDER_INTENT 那道闸同一份开关
      gate: () => prime.mode,
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
  // 决策 Agent 挂载完再挂分析 Agent（原因见上方 marketAnalyst 注释）
  marketAnalyst.attach();

  new RiskGuardAgent(
    bus,
    new RiskRules({
      maxPositionWeight: config.risk.maxPositionWeight,
      maxOrderValue: config.risk.maxOrderValue,
      maxDrawdownPct: config.risk.maxDrawdownPct,
      minTradeValue: config.risk.minTradeValue,
      grossCap: config.strategy.maxGrossExposure,
      mode: tradingMode,
    }),
    portfolio,
    book,
    tradingMode,
  ).attach();

  return {
    bus,
    book,
    portfolio,
    broker,
    strategy,
    allocator,
    // 活引用：pipeline.primeMode = true 必须立刻对所有闸门生效
    get primeMode(): boolean {
      return prime.mode;
    },
    set primeMode(v: boolean) {
      prime.mode = v;
    },
  };
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
  // 逐根之间等自定义策略沙箱排空：同步引擎的信号当根落地，异步引擎（worker
  // 往返）不排空的话信号会积压到回放结束，订单互相取代、一单都成不了。
  // 沙箱从未用过时（纯同步引擎回测）这个 await 立即返回，零开销。
  await streamBars(pipeline.bus, pipeline.book, bars, async () => {
    await sandboxIdle();
  });
}

/** 按策略引擎装配纯规则策略；模型失败时的回退也走这里，保证口径一致。 */
export function buildRuleStrategy(strategy: AppConfig["strategy"], allowShort: boolean): Strategy {
  switch (strategy.engine) {
    case "adaptive":
      return new AdaptiveTrendStrategy(
        strategy.fastWindow,
        strategy.slowWindow,
        strategy.maxTargetWeight,
        allowShort,
      );
    case "breakout":
      // 突破引擎：fastWindow = 离场反向通道，slowWindow = 入场通道
      return new BreakoutStrategy(
        strategy.fastWindow,
        strategy.slowWindow,
        strategy.maxTargetWeight,
        allowShort,
      );
    case "meanrev":
      return new MeanReversionStrategy(
        strategy.fastWindow,
        strategy.slowWindow,
        strategy.maxTargetWeight,
        allowShort,
      );
    case "custom":
      // 自定义策略：用户写的代码在沙箱里执行。编译在保存策略时就已校验过，
      // 这里再失败（理论上只有改代码后引用未刷新）直接抛，别静默换成别的引擎
      return new CustomStrategy({ code: strategy.strategyCode, allowShort });
    case "momentum":
    default:
      return new MomentumStrategy(
        strategy.fastWindow,
        strategy.slowWindow,
        strategy.maxTargetWeight,
        allowShort,
      );
  }
}

/** 给 AI 配置器套一层风险倾斜：模型定方向，这里只调风险敞口。 */
function withRiskTilt(
  inner: AssetAllocator,
  tilt: (weights: Record<string, number>, inputs: AssetSnapshot[]) => Promise<Record<string, number>>,
): AssetAllocator {
  return {
    async allocate(inputs: AssetSnapshot[]): Promise<AllocationResult> {
      const r = await inner.allocate(inputs);
      const weights = await tilt(r.weights, inputs);
      const sum = Object.values(weights).reduce((a, b) => a + b, 0);
      const changed = Object.keys(weights).some((s) => Math.abs((weights[s] ?? 0) - (r.weights[s] ?? 0)) > 1e-6);
      return {
        ...r,
        weights,
        cashWeight: Number(Math.max(0, 1 - sum).toFixed(6)),
        notes: changed ? [...r.notes, "已按风险平价/波动率目标调整敞口（方向仍以模型判断为准）"] : r.notes,
      };
    },
  };
}
