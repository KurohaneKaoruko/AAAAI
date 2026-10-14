/**
 * 引擎控制器：管理一次「回测」或「实时」运行。
 *
 * 职责：
 * - 依据「连接 + 自选标的」拉取多标的历史/实时 K 线
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
import { LivePoller, mergeBarsByTime, streamBars } from "../data/streaming.js";
import { getLogger } from "../core/logger.js";
import type { AppConfig } from "../configSchema.js";
import { redactConfig } from "../configSchema.js";
import { buildPipeline, type Pipeline } from "../agents/orchestrator.js";
import type { ExchangeAdapter, Ticker } from "../exchanges/types.js";
import type { ConnectionManager } from "../exchanges/connectionManager.js";
import type { WatchlistManager } from "../watchlist.js";
import type { LlmManager } from "../llm/llmManager.js";
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
  /** 实时行情快照（自选标的） */
  tickers: Ticker[];
  /** 本次运行各标的的标记价（持仓浮盈按此计算） */
  prices: Record<string, number>;
  equityCurve: EquityPoint[];
  events: EngineEventLine[];
  broker: { name: string; paper: boolean } | null;
  strategy: string | null;
  realizedPnl: number;
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

export class EngineController {
  private state: EngineState;
  private listeners = new Set<(b: Broadcast) => void>();
  private pipeline: Pipeline | null = null;
  private poller: LivePoller | null = null;
  private tickerTimer: NodeJS.Timeout | null = null;
  private stopRequested = false;
  private eventLines: EngineEventLine[] = [];

  constructor(
    private config: AppConfig,
    private readonly connections: ConnectionManager,
    private readonly watchlist: WatchlistManager,
    private readonly llm: LlmManager,
  ) {
    this.llm.setStrategy(config.llm.strategy);
    if (config.strategy.decisionSource !== "rules") {
      this.llm.setActiveKind(config.strategy.decisionSource);
    }
    this.state = this.freshState();
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
      comparison: null,
      comparing: false,
      config: {},
    };
  }

  private emitState(): void {
    this.broadcast({ type: "state", data: this.snapshot() });
  }

  // ---------------- 事件转译 ----------------

  private attachEventRelay(bus: EventBus): void {
    const relay = (event: Event): void => {
      const line: EngineEventLine = {
        seq: event.seq,
        topic: event.topic,
        timestamp: new Date(event.timestamp).toISOString(),
        summary: summarize(event),
      };
      this.eventLines.push(line);
      if (this.eventLines.length > MAX_EVENT_LINES) this.eventLines.shift();
      this.state.events = [...this.eventLines].reverse();
      this.broadcast({ type: "event", data: line });
    };
    for (const topic of Object.values(Topic)) bus.subscribe(topic, relay);
  }

  // ---------------- 行情快照 ----------------

  /** 拉取自选标的行情（页面顶栏 ticker）。 */
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
    throw new Error("没有可运行的标的：请在「自选标的」页添加，或在运行面板手动输入");
  }

  async start(options: StartOptions): Promise<void> {
    if (this.state.status === "running") {
      throw new Error("引擎正在运行，请先停止");
    }
    this.stopRequested = false;
    this.eventLines = [];

    const connection = this.resolveConnection(options.connectionId);
    const symbols = this.resolveSymbols(connection.id, options.symbols);
    const interval = options.interval ?? this.config.market.interval;
    const adapter = this.connections.adapter(connection.id);

    const liveTrading =
      this.config.execution.mode === "live" &&
      Boolean(adapter.meta.supportsTrading) &&
      adapter.meta.requiresKeys;

    this.pipeline = buildPipeline(this.config, {
      adapter,
      liveTrading,
      llm: this.config.llm.enabled ? this.llm : null,
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
    const groups = await Promise.all(symbols.map((s) => adapter.fetchKlines(s, interval, limit)));
    const bars = mergeBarsByTime(groups);
    const pipeline = this.pipeline!;
    for (const bar of bars) {
      if (this.stopRequested) break;
      await streamBars(pipeline.bus, pipeline.book, [bar]);
    }
    this.refreshFromPipeline();
    this.emitState();
  }

  private async runLive(adapter: ExchangeAdapter, symbols: string[], interval: string): Promise<void> {
    const pipeline = this.pipeline!;
    // 1) 预热历史
    const warmup = await Promise.all(
      symbols.map((s) => adapter.fetchKlines(s, interval, this.config.market.barCount)),
    );
    await streamBars(pipeline.bus, pipeline.book, mergeBarsByTime(warmup));
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
      await streamBars(pipeline.bus, pipeline.book, bars);
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
      market: { ...this.config.market, ...(patch.market ?? {}) },
    };
    this.state.config = redactConfig(this.config);
    this.llm.setStrategy(this.config.llm.strategy);
    if (this.config.strategy.decisionSource !== "rules") {
      this.llm.setActiveKind(this.config.strategy.decisionSource);
    }
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
    this.state.broker = { name: broker.name, paper: broker.paper };
    this.state.strategy = strategy.name;
  }
}

/** 事件 -> 一行摘要。 */
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
