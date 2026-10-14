/**
 * 引擎控制器：管理一次"回测"或"实时"运行，
 * 统一维护可观测状态（指标/持仓/权益曲线/事件流），并向订阅者广播。
 */

import { EventBus, Topic } from "../core/eventBus.js";
import type { Event } from "../core/eventBus.js";
import type { EquityPoint, PortfolioMetrics, Position } from "../core/types.js";
import { streamBars, LivePoller, type PriceBook } from "../data/marketDataService.js";
import { getLogger } from "../core/logger.js";
import type { AppConfig } from "../configSchema.js";
import { redactConfig } from "../configSchema.js";
import { buildPipeline, type Pipeline } from "../agents/orchestrator.js";
import type { Broker } from "../execution/broker.js";
import type { DataSource } from "../data/dataSource.js";
import type { Strategy } from "../strategies/strategy.js";
import type { PortfolioManager } from "../portfolio/portfolioManager.js";

const log = getLogger("engine");

export type EngineStatus = "idle" | "running" | "stopped" | "error";
export type EngineMode = "backtest" | "live";

export interface EngineEventLine {
  seq: number;
  topic: string;
  timestamp: string;
  summary: string;
  payload?: unknown;
}

export interface EngineState {
  status: EngineStatus;
  mode: EngineMode | null;
  symbol: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  metrics: PortfolioMetrics | null;
  positions: Position[];
  prices: Record<string, number>;
  equityCurve: EquityPoint[];
  events: EngineEventLine[];
  broker: { name: string; paper: boolean } | null;
  strategy: string | null;
  config: Record<string, unknown>;
}

export interface Broadcast {
  type: "state" | "event" | "log";
  data: unknown;
}

const MAX_EVENT_LINES = 300;

export class EngineController {
  private state: EngineState;
  private listeners = new Set<(b: Broadcast) => void>();
  private pipeline: Pipeline | null = null;
  private poller: LivePoller | null = null;
  private stopRequested = false;
  private eventLines: EngineEventLine[] = [];

  constructor(private config: AppConfig) {
    this.state = this.freshState();
  }

  // ---------- 订阅 ----------

  onBroadcast(listener: (b: Broadcast) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private broadcast(b: Broadcast): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(b);
      } catch {
        /* 单个订阅者异常不影响他人 */
      }
    }
  }

  // ---------- 状态 ----------

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
      symbol: null,
      startedAt: null,
      finishedAt: null,
      error: null,
      metrics: null,
      positions: [],
      prices: {},
      equityCurve: [],
      events: [],
      broker: null,
      strategy: null,
      config: {},
    };
  }

  private refreshFromPipeline(): void {
    if (!this.pipeline) return;
    const { portfolio, broker, book, strategy } = this.pipeline;
    this.state.metrics = portfolio.metrics();
    this.state.positions = portfolio.positionsSnapshot();
    this.state.prices = book.snapshot();
    this.state.equityCurve = portfolio.equityCurve().slice(-1000);
    this.state.broker = { name: broker.name, paper: broker.paper };
    this.state.strategy = strategy.name;
  }

  /** 把总线事件转成一行可读日志。 */
  private attachEventRelay(bus: EventBus): void {
    const relay = (event: Event): void => {
      const line: EngineEventLine = {
        seq: event.seq,
        topic: event.topic,
        timestamp: new Date(event.timestamp).toISOString(),
        summary: summarize(event),
        payload: event.payload,
      };
      this.eventLines.push(line);
      if (this.eventLines.length > MAX_EVENT_LINES) this.eventLines.shift();
      this.state.events = [...this.eventLines].reverse();
      this.broadcast({ type: "event", data: line });
    };
    for (const topic of Object.values(Topic)) bus.subscribe(topic, relay);
  }

  // ---------- 运行控制 ----------

  async start(mode: EngineMode, options: { symbol?: string; bars?: number } = {}): Promise<void> {
    if (this.state.status === "running") {
      throw new Error("引擎正在运行，请先停止");
    }
    this.stopRequested = false;
    this.eventLines = [];
    this.pipeline = buildPipeline(this.config);
    const symbol = options.symbol ?? this.config.market.symbols[0] ?? "BTCUSDT";
    this.state = {
      ...this.freshState(),
      status: "running",
      mode,
      symbol,
      startedAt: new Date().toISOString(),
      config: redactConfig(this.config),
    };
    this.attachEventRelay(this.pipeline.bus);
    this.emitState();

    try {
      if (mode === "backtest") {
        await this.runBacktest(this.pipeline, symbol, options.bars ?? this.config.market.barCount);
        this.finish();
      } else {
        await this.runLive(this.pipeline, symbol);
      }
    } catch (err) {
      this.state.status = "error";
      this.state.error = (err as Error).message;
      this.state.finishedAt = new Date().toISOString();
      this.emitState();
      throw err;
    }
  }

  private async runBacktest(pipeline: Pipeline, symbol: string, limit: number): Promise<void> {
    log.info("回测开始 %s 共 %d 根 K 线", symbol, limit);
    const bars = await pipeline.source.fetchBars({
      symbol,
      limit,
      interval: this.config.market.interval,
    });
    await streamBars(pipeline.bus, pipeline.book, bars);
    this.refreshFromPipeline();
    this.emitState();
  }

  private async runLive(pipeline: Pipeline, symbol: string): Promise<void> {
    // 1) 先拉历史预热策略，再进入轮询
    const warmup = await pipeline.source.fetchBars({
      symbol,
      limit: this.config.market.barCount,
      interval: this.config.market.interval,
    });
    await streamBars(pipeline.bus, pipeline.book, warmup);
    this.refreshFromPipeline();
    this.emitState();

    // 2) 轮询新 K 线
    const poller = new LivePoller(pipeline.source, pipeline.bus, pipeline.book, {
      symbol,
      interval: this.config.market.interval,
      pollMs: this.config.market.pollMs,
    });
    this.poller = poller;
    poller.start(async (bars) => {
      if (this.stopRequested) return;
      await streamBars(pipeline.bus, pipeline.book, bars);
      this.refreshFromPipeline();
      this.emitState();
      // 3) 回撤熔断
      const dd = pipeline.portfolio.drawdownPct;
      if (dd >= this.config.risk.maxDrawdownPct) {
        log.warn("回撤 %.2f%% 达到熔断线，自动停机", dd * 100);
        this.stop();
      }
    });
    log.info("实时模式已启动: %s 每 %dms 轮询", symbol, this.config.market.pollMs);
  }

  stop(): void {
    this.poller?.stop();
    this.poller = null;
    this.stopRequested = true;
    if (this.state.status === "running") {
      this.state.status = "stopped";
      this.state.finishedAt = new Date().toISOString();
    }
    this.emitState();
  }

  /** 运行中更新风控/策略参数（下一次流水线生效）。 */
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
    this.emitState();
    return this.config;
  }

  private finish(): void {
    this.state.status = "stopped";
    this.state.finishedAt = new Date().toISOString();
    this.emitState();
  }

  private emitState(): void {
    this.broadcast({ type: "state", data: this.snapshot() });
  }
}

/** 事件 -> 一行摘要。 */
function summarize(event: Event): string {
  const p = event.payload as Record<string, unknown> | undefined;
  const price = typeof p?.price === "number" ? p.price.toFixed(4) : undefined;
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
    case Topic.FILL:
      return `成交 ${String((p as { order?: { symbol?: string } })?.order?.symbol ?? "")} @ ${price ?? "?"}`;
    case Topic.ORDER_REJECTED:
      return `被拒 ${String((p as { symbol?: string })?.symbol ?? "")}`;
    default:
      return "";
  }
}

export type { Broker, DataSource, Strategy, PortfolioManager, PriceBook };
