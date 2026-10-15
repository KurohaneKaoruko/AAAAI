/**
 * 引擎控制器：管理一次「回测」或「实时」运行。
 *
 * 职责：
 * - 依据「连接 + 候选池」拉取多标的历史/实时 K 线
 * - 广播状态与事件（SSE 给 WebUI）
 * - 组合指标、持仓、成交流水与行情快照
 * - 回撤熔断自动停机
 */

import { EventBus, Topic } from "../core/eventBus.js";
import type { Event } from "../core/eventBus.js";
import type {
  Bar,
  EquityPoint,
  PortfolioMetrics,
  Position,
  TradeRecord,
} from "../core/types.js";
import { LivePoller, mergeBarsByTime } from "../data/streaming.js";
import { getLogger } from "../core/logger.js";
import type { AppConfig } from "../configSchema.js";
import { redactConfig } from "../configSchema.js";
import { buildPipeline, feed, type Pipeline, type PipelineJournal } from "../agents/orchestrator.js";
import { PaperBroker, type SlicedOrderReport } from "../execution/paperBroker.js";
import { StrategyStore, type StrategyProfile, type StrategyProfileInput } from "../strategies/profileStore.js";
import { defaultToolBox, type ToolBox, type ToolContext } from "../llm/tools.js";
import type { ExchangeAdapter, Ticker } from "../exchanges/types.js";
import type { ConnectionManager } from "../exchanges/connectionManager.js";
import type { WatchlistManager } from "../watchlist.js";
import type { LlmManager } from "../llm/llmManager.js";
import type { NewsService } from "../news/newsService.js";
import { toDigest, type NewsDigest } from "../news/types.js";
import type { EvolutionEngine } from "../evolution/engine.js";
import { runComparison, buildRunners, type ComparisonResult, type RunnerKind } from "../bench/comparison.js";

const log = getLogger("engine");


export interface EngineEventLine {
  seq: number;
  topic: string;
  timestamp: string;
  summary: string;
}

/**
 * 全局状态。
 *
 * 这里**不再**包含任何"某一次运行"的指标/持仓/流水 —— 那些都在机器人那边
 * （/api/bots）。单账户引擎删除后，引擎只剩三件事：配置、候选池行情、多模型对照。
 */
export interface EngineState {
  /** 候选池实时行情 */
  tickers: Ticker[];
  /** 最近一次多模型对照结果 */
  comparison: ComparisonResult | null;
  /** 对照实验进行中 */
  comparing: boolean;
  /** 生效中的配置（已脱敏） */
  config: Record<string, unknown>;
}

export type Broadcast = { type: "state"; data: EngineState };

const MAX_EVENT_LINES = 400;
/** 回测模式视为噪声、不逐条推送的主题 */
const NOISY_TOPICS = new Set<string>([Topic.BAR, Topic.MARKET_VIEW]);
/** 回测事件批量推送间隔（毫秒） */
const EVENT_FLUSH_MS = 120;

export class EngineController {
  private state: EngineState;
  private listeners = new Set<(b: Broadcast) => void>();
  private pipeline: Pipeline | null = null;
  private poller: LivePoller | null = null;
  private tickerTimer: NodeJS.Timeout | null = null;
  private stopRequested = false;
  /** 收盘价序列（自我进化结算用） */
  private priceSeries = new Map<string, number[]>();
  /** 带时间戳的 K 线（给大模型的 get_history 用） */
  private historyLog = new Map<string, { timestamp: string; close: number }[]>();
  private barsAdvanced = 0;
  private lastEvolveAt = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private startedAtMs = 0;

  constructor(
    private config: AppConfig,
    private readonly connections: ConnectionManager,
    private readonly watchlist: WatchlistManager,
    private readonly llm: LlmManager,
    private readonly news: NewsService | undefined,
    private readonly evolution: EvolutionEngine | undefined,
    // 没显式传入时按当前 config.strategy 现场建一份（单测/一次性实验用，不落盘）
    private readonly strategies: StrategyStore = new StrategyStore(".", {
      memoryOnly: true,
      seed: { ...config.strategy, name: "默认策略" },
    }),
  ) {
    this.llm.setStrategy(config.llm.strategy);
    // 先把默认策略并进 config（此时 this.state 还不存在），再初始化状态
    this.config = { ...this.config, strategy: { ...this.config.strategy, ...strategyFields(this.strategies.default()) } };
    this.state = this.freshState();
  }

  // ---------------- 策略列表 ----------------

  /** 策略列表。 */
  strategyList(): StrategyProfile[] {
    return this.strategies.list();
  }

  /** 当前默认策略 id。 */
  defaultStrategyId(): string {
    return this.strategies.defaultIdValue();
  }

  createStrategy(input: StrategyProfileInput): StrategyProfile {
    const created = this.strategies.create(input);
    this.applyActiveStrategy();
    return created;
  }

  updateStrategy(id: string, patch: Partial<StrategyProfileInput>): StrategyProfile {
    const updated = this.strategies.update(id, patch);
    this.applyActiveStrategy();
    return updated;
  }

  duplicateStrategy(id: string): StrategyProfile {
    const copy = this.strategies.duplicate(id);
    this.applyActiveStrategy();
    return copy;
  }

  removeStrategy(id: string): void {
    this.strategies.remove(id);
    this.applyActiveStrategy();
  }

  setDefaultStrategy(id: string): StrategyProfile {
    const p = this.strategies.setDefault(id);
    this.applyActiveStrategy();
    return p;
  }

  /**
   * 把默认策略同步进 config.strategy：单次运行/对照实验都读它，
   * 这样面板改的是同一条数据，不会出现「策略里改了，运行用的却是另一份」。
   */
  private applyActiveStrategy(): void {
    const profile = this.strategies.default();
    this.config = { ...this.config, strategy: { ...this.config.strategy, ...strategyFields(profile) } };
    this.state.config = redactConfig(this.config);
    const modelKind = modelKindOf(profile.decisionSource);
    if (modelKind) this.llm.setActiveKind(modelKind);
  }


  // ---------------- 订阅 / 状态 ----------------

  onBroadcast(listener: (b: Broadcast) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private broadcast(b: Broadcast): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(b);
      } catch {
        /* 单个订阅者异常不影响其他订阅者 */
      }
    }
  }

  snapshot(): EngineState {
    return { ...this.state, config: redactConfig(this.config) };
  }

  getConfig(): AppConfig {
    return this.config;
  }

  private freshState(): EngineState {
    return {
      tickers: [],
      comparison: null,
      comparing: false,
      config: redactConfig(this.config),
    };
  }

  private emitState(): void {
    this.broadcast({ type: "state", data: this.snapshot() });
  }


  // ---------------- 行情快照 ----------------

  /** 拉取候选池行情（页面顶栏 ticker）。 */
  async refreshTickers(): Promise<Ticker[]> {
    const items = this.watchlist.list();
    if (items.length === 0) return this.state.tickers;
    const byConnection = new Map<string, string[]>();
    for (const item of items) {
      const list = byConnection.get(item.connectionId) ?? [];
      list.push(item.symbol);
      byConnection.set(item.connectionId, list);
    }
    const out: Ticker[] = [];
    for (const [connectionId, symbols] of byConnection) {
      try {
        const adapter = this.connections.adapter(connectionId);
        out.push(...(await adapter.fetchTickers(symbols)));
      } catch (err) {
        log.warn("行情刷新失败[%s]: %s", connectionId, (err as Error).message);
      }
    }
    this.state.tickers = out;
    return out;
  }

  private startTickerPolling(intervalMs = 10_000): void {
    this.tickerTimer = setInterval(() => {
      void this.refreshTickers().then(() => this.emitState()).catch(() => undefined);
    }, intervalMs);
  }

  // ---------------- 运行控制 ----------------

  /**
   * 解析「验证类」请求要用的运行目标：连接、周期、候选池标的。
   * 前推验证与稳健性体检都在这里复用，保证和真正跑回测用的是同一套标的。
   */
  resolveRunTarget(connectionId?: string, symbols?: string[]): {
    connection: { id: string; label: string };
    interval: string;
    symbols: string[];
  } {
    const connection = this.resolveConnection(connectionId);
    return {
      connection,
      interval: this.config.market.interval,
      // 显式指定优先（验证接口会用），否则按当前运行标的 / 候选池解析
      symbols: symbols && symbols.length > 0 ? symbols : this.resolveSymbols(connection.id),
    };
  }

  private resolveConnection(connectionId?: string): { id: string; label: string } {
    const connections = this.connections.list();
    if (connections.length === 0) {
      throw new Error("尚未配置任何交易所连接，请先在「交易所」页添加连接");
    }
    const id = connectionId || this.config.execution.connectionId || connections[0]!.id;
    const found = connections.find((c) => c.id === id);
    if (!found) throw new Error(`连接不存在: ${id}`);
    return { id: found.id, label: found.label };
  }

  private resolveSymbols(connectionId: string, requested?: string[]): string[] {
    if (requested && requested.length > 0) return requested;
    const fromConfig = this.config.market.symbols.filter(Boolean);
    if (fromConfig.length > 0) return fromConfig;
    const fromWatchlist = this.watchlist
      .list()
      .filter((w) => w.connectionId === connectionId)
      .map((w) => w.symbol);
    if (fromWatchlist.length > 0) return fromWatchlist;
    throw new Error("没有可运行的标的：请在「策略 → 候选池」添加，或在运行面板手动输入");
  }

  /**
   * 多模型并行模拟盘：同一份行情、同一套风控，每个模型独立操盘独立记账。
   * 用来横向比较「哪个模型更会赚钱」。
   */
  async runModelComparison(options: {
    symbols?: string[];
    bars?: number;
    interval?: string;
    runnerIds?: string[];
    includeBaseline?: boolean;
    kinds?: RunnerKind[];
  } = {}): Promise<ComparisonResult> {
    if (this.state.comparing) {
      throw new Error("对照实验正在进行中");
    }
    this.state.comparing = true;
    this.emitState();

    const connection = this.resolveConnection();
    const symbols = this.resolveSymbols(connection.id, options.symbols);
    const interval = options.interval ?? this.config.market.interval;
    const adapter = this.connections.adapter(connection.id);

    // 组装选手：指定 id 优先，否则按 kind 全选 + 可选基线
    const all = this.llm.list();
    const wanted = options.runnerIds?.length
      ? all.filter((p) => options.runnerIds!.includes(p.id))
      : all.filter((p) => !options.kinds || options.kinds.includes(p.kind as RunnerKind));

    const runners = buildRunners({
      profiles: wanted,
      clientFor: (id) => this.llm.clientFor(id),
      includeBaseline: options.includeBaseline ?? true,
    });
    if (runners.length === 0) {
      this.state.comparing = false;
      throw new Error("没有可参赛的模型：请先在「LLM 大模型」页添加并配置密钥");
    }

    try {
      const result = await runComparison(this.config, {
        adapter,
        symbols,
        bars: options.bars ?? this.config.market.barCount,
        interval,
        liveTrading: false, // 对照实验始终用本地模拟成交，避免动真钱
        runners,
      });
      this.state.comparison = result;
      return result;
    } finally {
      this.state.comparing = false;
      this.emitState();
    }
  }


  /** LLM 管理器（面板路由使用）。 */
  llmManager(): LlmManager {
    return this.llm;
  }

  /** 运行中更新参数（下次流水线生效）。 */
  applyConfig(patch: Partial<AppConfig>): AppConfig {
    const { auth: _ignoredAuth, ...rest } = patch;
    this.config = {
      ...this.config,
      ...rest,
      auth: this.config.auth,
      risk: { ...this.config.risk, ...(patch.risk ?? {}) },
      strategy: { ...this.config.strategy, ...(patch.strategy ?? {}) },
      llm: { ...this.config.llm, ...(patch.llm ?? {}) },
      execution: { ...this.config.execution, ...(patch.execution ?? {}) },
      optimize: { ...this.config.optimize, ...(patch.optimize ?? {}) },
      cost: { ...this.config.cost, ...(patch.cost ?? {}) },
      market: { ...this.config.market, ...(patch.market ?? {}) },
      news: { ...this.config.news, ...(patch.news ?? {}) },
      evolution: { ...this.config.evolution, ...(patch.evolution ?? {}) },
    };
    this.state.config = redactConfig(this.config);
    // 配置小节各自持有引用，改完必须通知，否则服务仍在用旧配置
    this.news?.useConfig(this.config.news);
    this.evolution?.useConfig(this.config);
    this.llm.setStrategy(this.config.llm.strategy);
    const kind = modelKindOf(this.config.strategy.decisionSource);
    if (kind) this.llm.setActiveKind(kind);
    this.emitState();
    return this.config;
  }
}

/** 策略实体 -> config.strategy 需要的字段（只挑策略侧，不动其它段）。 */
function strategyFields(p: StrategyProfile) {
  return {
    decisionSource: p.decisionSource,
    fastWindow: p.fastWindow,
    slowWindow: p.slowWindow,
    maxTargetWeight: p.maxTargetWeight,
    selfAllocating: p.selfAllocating,
    maxPositions: p.maxPositions,
    maxGrossExposure: p.maxGrossExposure,
    allocationInterval: p.allocationInterval,
    hybridInfluence: p.hybridInfluence,
    hybridAnalysisTtlMs: p.hybridAnalysisTtlMs,
  };
}

/** 事件 -> 一行摘要。 */
/** 决策来源 -> 对应的模型池类型；纯规则/无模型时为 null。 */
function modelKindOf(source: string): "chat" | "systemone" | null {
  if (source === "chat" || source === "hybrid") return "chat";
  if (source === "systemone") return "systemone";
  return null;
}

