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

export type EngineStatus = "idle" | "running" | "stopped" | "error";
export type EngineMode = "backtest" | "live";

export interface EngineEventLine {
  seq: number;
  topic: string;
  timestamp: string;
  summary: string;
}

export interface EngineState {
  status: EngineStatus;
  mode: EngineMode | null;
  /** 本次运行的标的 */
  symbols: string[];
  /** 行情连接 ID */
  connectionId: string | null;
  connectionLabel: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  metrics: PortfolioMetrics | null;
  positions: Position[];
  trades: TradeRecord[];
  /** 实时行情快照（候选池） */
  tickers: Ticker[];
  /** 本次运行各标的的标记价（持仓浮盈按此计算） */
  prices: Record<string, number>;
  equityCurve: EquityPoint[];
  events: EngineEventLine[];
  broker: {
    name: string;
    paper: boolean;
    /** 拆单执行状态（只在 paper 模式下有值） */
    slicing?: {
      algo: "none" | "twap" | "vwap";
      slices: number;
      pending: SlicedOrderReport[];
      completed: SlicedOrderReport[];
      /** 已完成拆单的累计实施短缺（bps，正 = 多付） */
      avgShortfallBps: number;
      /** 已完成拆单省下的成本（相对一次性成交的差额，按名义金额累计） */
      savedCost: number;
    };
  } | null;
  strategy: string | null;
  realizedPnl: number;
  /** 回测进度与耗时 */
  progress: { bars: number; total: number; durationMs: number; filtered: number } | null;
  /** 最近一次多模型对照结果 */
  comparison: ComparisonResult | null;
  /** 对照实验进行中 */
  comparing: boolean;
  config: Record<string, unknown>;
}

export type Broadcast =
  | { type: "state"; data: EngineState }
  | { type: "event"; data: EngineEventLine };

export interface StartOptions {
  mode: EngineMode;
  /** 指定标的；缺省用自选列表（按连接过滤） */
  symbols?: string[];
  connectionId?: string;
  bars?: number;
  interval?: string;
}

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
  private eventLines: EngineEventLine[] = [];
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
    private readonly news?: NewsService,
    private readonly evolution?: EvolutionEngine,
  ) {
    this.llm.setStrategy(config.llm.strategy);
    const modelKind = modelKindOf(config.strategy.decisionSource);
    if (modelKind) this.llm.setActiveKind(modelKind);
    this.state = this.freshState();
  }

  // ---------------- 新闻 / 进化 ----------------

  /** 记录收盘价序列 + 推进计数，到期时让进化引擎结算决策。 */
  private trackBar(bar: Bar): void {
    const series = this.priceSeries.get(bar.symbol) ?? [];
    series.push(bar.close);
    if (series.length > 600) series.shift();
    this.priceSeries.set(bar.symbol, series);

    const log = this.historyLog.get(bar.symbol) ?? [];
    log.push({ timestamp: bar.timestamp.toISOString(), close: bar.close });
    if (log.length > 400) log.shift();
    this.historyLog.set(bar.symbol, log);
    this.barsAdvanced += 1;
    this.maybeEvolve();
  }

  /** 结算 + 评估（带 evaluateMs 节流，避免每根 K 线都算一遍）。 */
  private maybeEvolve(): void {
    const evo = this.evolution;
    if (!evo || !this.config.evolution.enabled) return;
    const now = Date.now();
    if (now - this.lastEvolveAt < Math.min(60_000, this.config.evolution.evaluateMs)) return;
    this.lastEvolveAt = now;
    // 基准：同窗口内等权持有全部候选的收益（超额才有意义）
    const symbols = [...this.priceSeries.keys()];
    let equalWeight = 0;
    if (symbols.length > 0) {
      const horizon = this.config.evolution.horizonBars;
      let sum = 0;
      let n = 0;
      for (const symbol of symbols) {
        const series = this.priceSeries.get(symbol)!;
        const from = series[Math.max(0, this.barsAdvanced - horizon)];
        const to = series[series.length - 1];
        if (!from || !to) continue;
        sum += (to - from) / from;
        n += 1;
      }
      if (n > 0) equalWeight = sum / n / n; // 等权组合收益
    }
    evo.settle(this.priceSeries, { advanceBars: this.barsAdvanced, equalWeight });
    evo.evaluate();
  }


  /** 新闻摘要获取器：未启用或没配源时返回空，决策链路照常。 */
  private newsFetcher(): (symbols: string[]) => Promise<NewsDigest[]> {
    const svc = this.news;
    if (!svc || !this.config.news.enabled) return async () => [];
    return async (symbols: string[]) => {
      const items = await svc.forSymbols(symbols).catch(() => []);
      return toDigest(items, Math.max(1, Math.floor(this.config.news.maxPerSymbol / 2)));
    };
  }

  /**
   * 给大模型的只读工具箱：行情、K 线、账户配置、候选池、新闻。
   * K 线直接用适配器现取（模型想看多长看多长），其余取流水线内的实时状态。
   */
  private tools(): { box: ToolBox; context: ToolContext } | undefined {
    if (!this.config.llm.agentEnabled) return undefined;
    const book = () => this.pipeline?.book;
    const portfolio = () => this.pipeline?.portfolio;
    const context: ToolContext = {
      candidates: () => this.state.symbols,
      price: (symbol) => book()?.last(symbol),
      history: (symbol, limit) => (this.historyLog.get(symbol) ?? []).slice(-limit),
      allocation: () => {
        const p = portfolio();
        if (!p) return { equity: 0, cash: 0, cashWeight: 1, holdings: [] };
        const equity = p.equity();
        return {
          equity: Number(equity.toFixed(2)),
          cash: Number(p.cash.toFixed(2)),
          cashWeight: Number((equity > 0 ? p.cash / equity : 1).toFixed(4)),
          holdings: p.positionsSnapshot().map((pos) => {
            const price = book()?.last(pos.symbol) ?? pos.avgCost;
            const value = pos.quantity * price;
            return {
              symbol: pos.symbol,
              weight: equity > 0 ? Number((value / equity).toFixed(4)) : 0,
              marketValue: Number(value.toFixed(2)),
              unrealizedPnl: Number(((price - pos.avgCost) * pos.quantity).toFixed(2)),
            };
          }),
        };
      },
      performance: () => {
        const m = portfolio()?.metrics();
        if (!m) return { totalReturn: 0, maxDrawdownPct: 0, totalFills: 0, openPositions: 0 };
        const initial = this.config.risk.initialCash;
        return {
          totalReturn: initial > 0 ? Number(((m.finalEquity - initial) / initial).toFixed(6)) : 0,
          maxDrawdownPct: m.maxDrawdownPct,
          totalFills: m.totalFills,
          openPositions: m.openPositions,
        };
      },
      news: async (symbol, limit) => {
        const svc = this.news;
        if (!svc || !this.config.news.enabled) return [];
        return svc.forSymbols([symbol]).then((items) => items.slice(0, limit)).catch(() => []);
      },
    };
    return { box: defaultToolBox(), context };
  }

  /** 决策留痕接口。 */
  private journal(): PipelineJournal | undefined {
    const evo = this.evolution;
    if (!evo || !this.config.evolution.enabled) return undefined;
    return {
      record: (entry) => {
        evo.record({
          owner: "engine",
          source: entry.source,
          weights: entry.weights,
          cashWeight: entry.cashWeight,
          confidence: entry.confidence,
          reason: entry.reason.slice(0, 300),
          refPrices: entry.refPrices,
          entryBarIndex: entry.entryBarIndex,
        });
      },
    };
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
      status: "idle",
      mode: null,
      symbols: [],
      connectionId: null,
      connectionLabel: null,
      startedAt: null,
      finishedAt: null,
      error: null,
      metrics: null,
      positions: [],
      trades: [],
      tickers: [],
      prices: {},
      equityCurve: [],
      events: [],
      broker: null,
      strategy: null,
      realizedPnl: 0,
      progress: null,
      comparison: null,
      comparing: false,
      config: {},
    };
  }

  private emitState(): void {
    this.broadcast({ type: "state", data: this.snapshot() });
  }

  // ---------------- 事件转译 ----------------

  /**
   * 事件转发。
   *
   * 回测往往在几十毫秒内跑完数百根 K 线，若逐条推送会瞬间灌进几百条事件
   * （且事件上限会把前面的挤掉）。因此回测模式下：
   *   1) K 线与市场解读属于高频噪声，不推送，只计数；
   *   2) 剩余事件先入缓冲，按节流批量推送。
   * 实时模式保持逐条推送（本来速度就慢）。
   */
  private attachEventRelay(bus: EventBus): void {
    const batch = this.state.mode === "backtest";
    const pending: EngineEventLine[] = [];

    const push = (line: EngineEventLine): void => {
      this.eventLines.push(line);
      if (this.eventLines.length > MAX_EVENT_LINES) this.eventLines.shift();
      this.state.events = [...this.eventLines].reverse();
      if (batch) pending.push(line);
      else this.broadcast({ type: "event", data: line });
    };

    const flush = (): void => {
      if (pending.length === 0) return;
      for (const line of pending) this.broadcast({ type: "event", data: line });
      pending.length = 0;
    };

    const relay = (event: Event): void => {
      // 自我进化的结算需要知道行情推进到哪了（不依赖前端事件流）
      if (event.topic === Topic.BAR) this.trackBar(event.payload as Bar);
      const noise = batch && NOISY_TOPICS.has(event.topic);
      if (noise) {
        this.state.progress = {
          ...(this.state.progress ?? { bars: 0, total: 0, durationMs: 0, filtered: 0 }),
          filtered: (this.state.progress?.filtered ?? 0) + 1,
        };
        return;
      }
      push({
        seq: event.seq,
        topic: event.topic,
        timestamp: new Date(event.timestamp).toISOString(),
        summary: summarize(event),
      });
    };

    for (const topic of Object.values(Topic)) bus.subscribe(topic, relay);

    if (batch) {
      this.flushTimer = setInterval(flush, EVENT_FLUSH_MS);
      // 回测结束（同步返回后）统一冲刷一次
      queueMicrotask(flush);
    }
  }

  private flushEvents(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
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

  async start(options: StartOptions): Promise<void> {
    if (this.state.status === "running") {
      throw new Error("引擎正在运行，请先停止");
    }
    this.stopRequested = false;
    this.eventLines = [];
    this.flushEvents();

    const connection = this.resolveConnection(options.connectionId);
    const symbols = this.resolveSymbols(connection.id, options.symbols);
    const interval = options.interval ?? this.config.market.interval;
    const adapter = this.connections.adapter(connection.id);

    const liveTrading =
      this.config.execution.mode === "live" &&
      Boolean(adapter.meta.supportsTrading) &&
      adapter.meta.requiresKeys;

    this.priceSeries.clear();
    this.historyLog.clear();
    this.barsAdvanced = 0;

    this.pipeline = buildPipeline(this.config, {
      adapter,
      liveTrading,
      llm: this.llm.clientForKind("chat"),
      soClient: this.llm.clientForKind("systemone"),
      // 新闻摘要：只进 prompt，不直接触发交易
      news: this.newsFetcher(),
      // 决策留痕：自我进化据此学习
      journal: this.journal(),
      // 大模型工具能力：让它自己查新闻/走势/当前配置
      tools: this.tools(),
    });
    if (this.config.execution.mode === "live" && !liveTrading) {
      log.warn("实盘模式不可用（适配器不支持交易或未配 Key），已自动降级为模拟成交");
    }

    this.state = {
      ...this.freshState(),
      // 保留已有行情快照，避免顶栏在运行期间空白
      tickers: this.state.tickers,
      status: "running",
      mode: options.mode,
      symbols,
      connectionId: connection.id,
      connectionLabel: connection.label,
      startedAt: new Date().toISOString(),
      config: redactConfig(this.config),
    };
    this.attachEventRelay(this.pipeline.bus);
    this.emitState();

    try {
      if (options.mode === "backtest") {
        await this.runBacktest(adapter, symbols, interval, options.bars ?? this.config.market.barCount);
        this.state.status = "stopped";
        this.state.finishedAt = new Date().toISOString();
        this.emitState();
        // 回测结束后刷新一次最新行情，供顶栏展示
        void this.refreshTickers()
          .then(() => this.emitState())
          .catch(() => undefined);
      } else {
        await this.runLive(adapter, symbols, interval);
      }
    } catch (err) {
      this.state.status = "error";
      this.state.error = (err as Error).message;
      this.state.finishedAt = new Date().toISOString();
      this.emitState();
      throw err;
    }
  }

  private async runBacktest(
    adapter: ExchangeAdapter,
    symbols: string[],
    interval: string,
    limit: number,
  ): Promise<void> {
    log.info("回测开始 %s 共 %d 根 K 线", symbols.join(","), limit);
    this.startedAtMs = Date.now();
    const groups = await Promise.all(symbols.map((s) => adapter.fetchKlines(s, interval, limit)));
    const bars = mergeBarsByTime(groups);
    const pipeline = this.pipeline!;
    for (const [i, bar] of bars.entries()) {
      if (this.stopRequested) break;
      await feed(pipeline, [bar]);
      this.state.progress = {
        bars: i + 1,
        total: bars.length,
        durationMs: Date.now() - this.startedAtMs,
        filtered: this.state.progress?.filtered ?? 0,
      };
    }
    this.flushEvents();
    this.state.progress = {
      bars: this.state.progress?.bars ?? bars.length,
      total: bars.length,
      durationMs: Date.now() - this.startedAtMs,
      filtered: this.state.progress?.filtered ?? 0,
    };
    this.refreshFromPipeline();
    this.emitState();
  }

  private async runLive(adapter: ExchangeAdapter, symbols: string[], interval: string): Promise<void> {
    const pipeline = this.pipeline!;
    // 1) 预热历史
    const warmup = await Promise.all(
      symbols.map((s) => adapter.fetchKlines(s, interval, this.config.market.barCount)),
    );
    await feed(pipeline, mergeBarsByTime(warmup));
    this.refreshFromPipeline();
    this.emitState();

    // 2) 轮询新 K 线
    const poller = new LivePoller(adapter, pipeline.bus, pipeline.book, {
      symbols,
      interval,
      pollMs: this.config.market.pollMs,
    });
    this.poller = poller;
    poller.start(async (bars: Bar[]) => {
      if (this.stopRequested) return;
      await feed(pipeline, bars);
      this.refreshFromPipeline();
      this.emitState();
      if (pipeline.portfolio.drawdownPct >= this.config.risk.maxDrawdownPct) {
        log.warn("回撤 %.2f%% 达到熔断线，自动停机", pipeline.portfolio.drawdownPct * 100);
        this.stop();
      }
    });
    this.startTickerPolling();
    log.info("实时模式已启动: %s 每 %dms 轮询", symbols.join(","), this.config.market.pollMs);
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
    if (this.state.status === "running") {
      throw new Error("引擎正在运行，请先停止后再做对照实验");
    }
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

  stop(): void {
    this.flushEvents();
    this.poller?.stop();
    this.poller = null;
    if (this.tickerTimer) clearInterval(this.tickerTimer);
    this.tickerTimer = null;
    this.stopRequested = true;
    if (this.state.status === "running") {
      this.state.status = "stopped";
      this.state.finishedAt = new Date().toISOString();
    }
    this.emitState();
  }

  /** LLM 管理器（面板路由使用）。 */
  llmManager(): LlmManager {
    return this.llm;
  }

  /** 运行中更新参数（下次流水线生效）。 */
  applyConfig(patch: Partial<AppConfig>): AppConfig {
    this.config = {
      ...this.config,
      ...patch,
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

  private refreshFromPipeline(): void {
    if (!this.pipeline) return;
    const { portfolio, broker, strategy } = this.pipeline;
    this.state.metrics = portfolio.metrics();
    this.state.positions = portfolio.positionsSnapshot();
    this.state.trades = portfolio.tradeHistory();
    this.state.realizedPnl = portfolio.realizedPnl();
    this.state.equityCurve = portfolio.equityCurve().slice(-1500);
    this.state.prices = this.pipeline.book.snapshot();
    this.state.broker = { name: broker.name, paper: broker.paper, ...this.slicingState() };
    this.state.strategy = strategy.name;
  }

  /** 拆单执行状态：只有 paper 券商有，且必须是真开了拆单（否则面板不该显示统计）。 */
  private slicingState(): Pick<NonNullable<EngineState["broker"]>, "slicing"> {
    const broker = this.pipeline?.broker;
    if (!(broker instanceof PaperBroker)) return {};
    const slicing = broker.slicingState();
    if (!slicing) return {};
    const done = slicing.completed;
    const avgShortfallBps =
      done.length > 0 ? done.reduce((a, o) => a + o.shortfallBps, 0) / done.length : 0;
    const savedCost = done.reduce(
      (a, o) => a + (o.referencePrice - o.averageFillPrice) * o.filledQuantity * (o.side === "BUY" ? 1 : -1),
      0,
    );
    return {
      slicing: {
        algo: slicing.algo,
        slices: slicing.slices,
        pending: slicing.pending,
        completed: done.slice(-20).reverse(),
        avgShortfallBps: Number(avgShortfallBps.toFixed(4)),
        savedCost: Number(savedCost.toFixed(4)),
      },
    };
  }
}

/** 事件 -> 一行摘要。 */
/** 决策来源 -> 对应的模型池类型；纯规则/无模型时为 null。 */
function modelKindOf(source: string): "chat" | "systemone" | null {
  if (source === "chat" || source === "hybrid") return "chat";
  if (source === "systemone") return "systemone";
  return null;
}

function summarize(event: Event): string {
  const p = event.payload as Record<string, unknown> | undefined;
  switch (event.topic) {
    case Topic.BAR: {
      const bar = p as unknown as { symbol: string; close: number };
      return `${bar.symbol} close=${bar.close}`;
    }
    case Topic.MARKET_VIEW: {
      const v = p as unknown as { symbol: string; trend: string; momentum: number };
      return `${v.symbol} ${v.trend} mom=${v.momentum.toFixed(4)}`;
    }
    case Topic.ALLOCATION: {
      const a = p as unknown as {
        weights: Record<string, number>;
        cashWeight: number;
        reason: string;
        source: string;
        notes: string[];
      };
      const held = Object.entries(a.weights ?? {})
        .sort((x, y) => y[1] - x[1])
        .map(([s, w]) => `${s} ${(w * 100).toFixed(0)}%`)
        .join(" / ");
      return `[${a.source}] ${held || "空仓"} · 现金 ${((a.cashWeight ?? 0) * 100).toFixed(0)}% · ${a.reason}${
        a.notes?.length ? `（${a.notes.join("；")}）` : ""
      }`;
    }
    case Topic.SIGNAL: {
      const s = p as unknown as { symbol: string; targetWeight: number; reason: string };
      return `${s.symbol} weight=${s.targetWeight} ${s.reason}`;
    }
    case Topic.ORDER_INTENT: {
      const o = p as unknown as { symbol: string; side: string; quantity: number };
      return `${o.side} ${o.symbol} qty=${o.quantity.toFixed(6)}`;
    }
    case Topic.FILL: {
      const f = p as unknown as { order?: { symbol?: string; side?: string }; price: number };
      return `成交 ${f.order?.side ?? ""} ${f.order?.symbol ?? ""} @ ${f.price.toFixed(4)}`;
    }
    case Topic.ORDER_REJECTED: {
      return `被拒 ${String((p as { symbol?: string })?.symbol ?? "")}`;
    }
    default:
      return "";
  }
}
