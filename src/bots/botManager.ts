/**
 * 机器人管理器：多个自动化交易并行运行。
 *
 * 每个机器人持有独立的流水线（策略 Agent / 风控 / 券商）与独立资金账户，
 * 因此互不干扰；行情若同源，各自轮询（互不阻塞）。
 *
 * 生命周期：
 *   构造 -> load(data/bots.json)
 *   start(id) -> 建流水线 -> live 起轮询器 / backtest 跑一次即止
 *   stop(id)  -> 停轮询器、回撤熔断时自动调用
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventBus, Topic } from "../core/eventBus.js";
import type { Event } from "../core/eventBus.js";
import { LivePoller, mergeBarsByTime } from "../data/streaming.js";
import { getLogger } from "../core/logger.js";
import type { AppConfig, DecisionSource } from "../configSchema.js";
import { buildPipeline, feed, type Pipeline, type PipelineJournal } from "../agents/orchestrator.js";
import type { LLMClient } from "../llm/llmClient.js";
import type { LlmManager, LlmProfile, ModelKind } from "../llm/llmManager.js";
import { StrategyStore, type StrategyProfile } from "../strategies/profileStore.js";
import type { EvolutionEngine } from "../evolution/engine.js";
import type { ExchangeAdapter } from "../exchanges/types.js";
import type { ConnectionManager } from "../exchanges/connectionManager.js";
import type {
  BotAllocation,
  BotConfig,
  BotHolding,
  BotInput,
  BotMetrics,
  BotState,
  BotView,
} from "./types.js";

const log = getLogger("bots");
const MAX_EVENTS_PER_BOT = 120;
/** 每个机器人保留的权益曲线点数（内存与传输都要节制）。 */
const CURVE_POINTS = 400;

interface Runtime {
  bus: EventBus;
  pipeline: Pipeline;
  poller: LivePoller | null;
  stopRequested: boolean;
}

export class BotManager {
  private bots: BotConfig[] = [];
  private states = new Map<string, BotState>();
  private events = new Map<string, { topic: string; timestamp: string; summary: string }[]>();
  private runtimes = new Map<string, Runtime>();

  constructor(
    private readonly dataDir: string,
    private config: AppConfig,
    private readonly connections: ConnectionManager,
    private readonly llm: LlmManager,
    private readonly strategies: StrategyStore = new StrategyStore(dataDir, {
      seed: {
        name: "默认策略",
        decisionSource: config.strategy.decisionSource,
        fastWindow: config.strategy.fastWindow,
        slowWindow: config.strategy.slowWindow,
        maxTargetWeight: config.strategy.maxTargetWeight,
        selfAllocating: config.strategy.selfAllocating,
        maxPositions: config.strategy.maxPositions,
        maxGrossExposure: config.strategy.maxGrossExposure,
        allocationInterval: config.strategy.allocationInterval,
        hybridInfluence: config.strategy.hybridInfluence,
        hybridAnalysisTtlMs: config.strategy.hybridAnalysisTtlMs,
      },
    }),
    /** 决策留痕：自我进化靠它学习。不传则该机器人不留痕（对照实验/测试用）。 */
    private readonly evolution?: EvolutionEngine,
  ) {
    this.load();
  }

  /**
   * 决策留痕出口：把机器人的每次决策交给进化引擎结算。
   * 以前只有单账户引擎留痕，机器人不写 —— 也就是说"用了机器人就等于关掉了自我进化"。
   */
  private journalFor(bot: BotConfig): PipelineJournal | undefined {
    const evo = this.evolution;
    if (!evo || !this.config.evolution.enabled) return undefined;
    return {
      record: (entry) => {
        evo.record({
          owner: `bot:${bot.name}`,
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

  private get path(): string {
    return join(this.dataDir, "bots.json");
  }

  // ---------------- 持久化 ----------------

  private load(): void {
    if (existsSync(this.path)) {
      try {
        this.bots = JSON.parse(readFileSync(this.path, "utf8")) as BotConfig[];
        if (this.migrateToStrategyRefs()) this.persist();
      } catch (err) {
        log.warn("bots.json 解析失败: %s", (err as Error).message);
        this.bots = [];
      }
    }
  }

  /**
   * 旧机器人的策略参数是内联覆盖（bot.strategy）。
   * 迁移：把它固化成名如「<机器人名> 策略」的一条策略，改为按 id 引用 ——
   * 这样多个机器人可以共用同一策略，而不是各自抄一份。
   */
  private migrateToStrategyRefs(): boolean {
    let changed = false;
    for (const bot of this.bots) {
      if (bot.strategyId) continue;
      // decisionSource 必须一起搬过去：漏了会把「对话模型机器人」悄悄降级成量化交易
      const created = this.strategies.create({
        name: `${bot.name} 策略`,
        decisionSource: bot.decisionSource,
        hybridAnalysisTtlMs: this.config.strategy.hybridAnalysisTtlMs,
        ...bot.strategy,
      });
      bot.strategyId = created.id;
      bot.decisionSource = created.decisionSource;
      changed = true;
      log.info("机器人「%s」的旧策略参数已迁移为策略「%s」(%s)", bot.name, created.name, created.id);
    }
    return changed;
  }

  /** 机器人真正生效的策略（引用失效时退回默认策略）。 */
  strategyOf(bot: BotConfig): StrategyProfile {
    return this.strategies.resolve(bot.strategyId);
  }

  /** 策略列表（面板用）。 */
  strategyList(): StrategyProfile[] {
    return this.strategies.list();
  }

  private persist(): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.bots, null, 2), { mode: 0o600 });
  }

  /** 更新配置引用（WebUI 改设置后调用）。 */
  useConfig(config: AppConfig): void {
    this.config = config;
  }

  // ---------------- CRUD ----------------

  list(): BotView[] {
    return this.bots.map((b) => this.toView(b));
  }

  get(id: string): BotConfig | undefined {
    return this.bots.find((b) => b.id === id);
  }

  create(input: BotInput): BotView {
    if (this.bots.length >= 12) {
      throw new Error("机器人数量已达上限（12），避免误开过多并行任务");
    }
    if (!input.name.trim()) throw new Error("请填写机器人名称");
    if (!input.symbols || input.symbols.length === 0) throw new Error("请至少选择一个标的");
    const connection = this.connections.get(input.connectionId);
    if (!connection) throw new Error(`连接不存在: ${input.connectionId}`);

    // 没给策略 id 就按传入参数新建一条：机器人永远引用一条真实存在的策略，
    // 不会出现「填了窗口却被忽略」的假配置。
    const strategyId =
      input.strategyId ??
      this.strategies
        .create({
          name: `${input.name.trim()} 策略`,
          decisionSource: input.decisionSource ?? "rules",
          fastWindow: input.strategy?.fastWindow ?? this.config.strategy.fastWindow,
          slowWindow: input.strategy?.slowWindow ?? this.config.strategy.slowWindow,
          maxTargetWeight: input.strategy?.maxTargetWeight ?? this.config.strategy.maxTargetWeight,
          selfAllocating: input.strategy?.selfAllocating ?? this.config.strategy.selfAllocating,
          maxPositions: input.strategy?.maxPositions ?? this.config.strategy.maxPositions,
          maxGrossExposure: input.strategy?.maxGrossExposure ?? this.config.strategy.maxGrossExposure,
          allocationInterval: input.strategy?.allocationInterval ?? this.config.strategy.allocationInterval,
          hybridInfluence: input.strategy?.hybridInfluence ?? this.config.strategy.hybridInfluence,
        })
        .id;

    const bot: BotConfig = {
      id: randomUUID().slice(0, 8),
      name: input.name.trim(),
      enabled: input.enabled ?? true,
      connectionId: input.connectionId,
      symbols: input.symbols,
      mode: input.mode ?? "live",
      interval: input.interval ?? this.config.market.interval,
      barCount: input.barCount ?? this.config.market.barCount,
      pollMs: input.pollMs ?? this.config.market.pollMs,
      decisionSource: input.decisionSource ?? "rules",
      modelProfileIds: input.modelProfileIds ?? [],
      decisionInterval: input.decisionInterval ?? this.config.llm.decisionInterval,
      // 策略是独立实体：机器人只存 id，参数以策略列表为准（改一处，全体引用生效）
      strategyId,
      strategy: {
        fastWindow: input.strategy?.fastWindow ?? this.config.strategy.fastWindow,
        slowWindow: input.strategy?.slowWindow ?? this.config.strategy.slowWindow,
        maxTargetWeight: input.strategy?.maxTargetWeight ?? this.config.strategy.maxTargetWeight,
        selfAllocating: input.strategy?.selfAllocating ?? this.config.strategy.selfAllocating,
        maxPositions: input.strategy?.maxPositions ?? this.config.strategy.maxPositions,
        maxGrossExposure: input.strategy?.maxGrossExposure ?? this.config.strategy.maxGrossExposure,
        allocationInterval: input.strategy?.allocationInterval ?? this.config.strategy.allocationInterval,
        hybridInfluence: input.strategy?.hybridInfluence ?? this.config.strategy.hybridInfluence,
      },
      risk: {
        initialCash: input.risk?.initialCash ?? this.config.risk.initialCash,
        maxPositionWeight: input.risk?.maxPositionWeight ?? this.config.risk.maxPositionWeight,
        maxOrderValue: input.risk?.maxOrderValue ?? this.config.risk.maxOrderValue,
        maxDrawdownPct: input.risk?.maxDrawdownPct ?? this.config.risk.maxDrawdownPct,
        minTradeValue: input.risk?.minTradeValue ?? this.config.risk.minTradeValue,
      },
      createdAt: new Date().toISOString(),
    };
    this.bots.push(bot);
    this.states.set(bot.id, freshState(bot.id));
    this.events.set(bot.id, []);
    this.persist();
    log.info("创建机器人「%s」(%s)", bot.name, bot.id);
    return this.toView(bot);
  }

  update(id: string, patch: Partial<BotInput>): BotView {
    const bot = this.get(id);
    if (!bot) throw new Error(`机器人不存在: ${id}`);
    if (patch.name !== undefined) bot.name = patch.name.trim() || bot.name;
    if (patch.enabled !== undefined) bot.enabled = patch.enabled;
    if (patch.symbols !== undefined && patch.symbols.length > 0) bot.symbols = patch.symbols;
    if (patch.connectionId !== undefined) {
      if (!this.connections.get(patch.connectionId)) throw new Error(`连接不存在: ${patch.connectionId}`);
      bot.connectionId = patch.connectionId;
    }
    if (patch.mode !== undefined) bot.mode = patch.mode;
    if (patch.interval !== undefined) bot.interval = patch.interval;
    if (patch.barCount !== undefined) bot.barCount = Math.max(2, patch.barCount);
    if (patch.pollMs !== undefined) bot.pollMs = Math.max(1000, patch.pollMs);
    if (patch.strategyId !== undefined) bot.strategyId = patch.strategyId;
    if (patch.modelProfileIds !== undefined) bot.modelProfileIds = patch.modelProfileIds;
    if (patch.decisionInterval !== undefined) bot.decisionInterval = Math.max(1, patch.decisionInterval);
    if (patch.strategy) bot.strategy = { ...bot.strategy, ...patch.strategy };
    if (patch.risk) bot.risk = { ...bot.risk, ...patch.risk };
    this.persist();
    return this.toView(bot);
  }

  remove(id: string): void {
    this.stop(id);
    this.bots = this.bots.filter((b) => b.id !== id);
    this.states.delete(id);
    this.events.delete(id);
    this.persist();
  }

  // ---------------- 运行 ----------------

  state(id: string): BotState {
    return this.states.get(id) ?? freshState(id);
  }

  isRunning(id: string): boolean {
    return this.state(id).status === "running";
  }

  /** 启动一个机器人（回测模式跑完即止）。 */
  async start(id: string): Promise<BotState> {
    const bot = this.get(id);
    if (!bot) throw new Error(`机器人不存在: ${id}`);
    if (this.isRunning(id)) throw new Error(`机器人「${bot.name}」已在运行`);
    if (!bot.symbols.length) throw new Error(`机器人「${bot.name}」没有标的`);

    const adapter: ExchangeAdapter = this.connections.adapter(bot.connectionId);
    // 选了「实时」就必须真的走实盘：条件不满足时直接拒绝启动，
    // 而不是悄悄退回本地撮合 —— 用户以为钱打出去了，实际没动，是最糟的结局。
    const liveTrading = this.resolveLiveTrading(bot, adapter);
    if (bot.mode === "live" && !liveTrading) {
      throw new Error(`机器人「${bot.name}」设为实时，但${this.liveBlockedReason(bot, adapter)}；不会启动`);
    }
    // 同一连接同时只允许一个实盘机器人，避免并行下真单
    if (liveTrading) this.assertLiveExclusive(bot);

    const runtime = this.buildRuntime(bot, adapter, this.lanesFor(bot), liveTrading);

    this.states.set(id, {
      ...freshState(id),
      liveTrading,
      status: "running",
      startedAt: new Date().toISOString(),
    });
    if (liveTrading) log.warn("机器人「%s」进入实盘：订单将真实发往交易所", bot.name);

    try {
      if (bot.mode === "backtest") {
        await this.runOnce(bot, runtime, adapter);
      } else {
        await this.runLive(bot, runtime, adapter);
      }
      const st = this.state(id);
      if (st.status === "running") {
        this.states.set(id, { ...st, status: "stopped", finishedAt: new Date().toISOString() });
      }
      return this.state(id);
    } catch (err) {
      this.states.set(id, {
        ...this.state(id),
        status: "error",
        error: (err as Error).message,
        finishedAt: new Date().toISOString(),
      });
      log.error("机器人「%s」异常: %s", bot.name, (err as Error).message);
      return this.state(id);
    }
  }

  stop(id: string): void {
    const rt = this.runtimes.get(id);
    if (rt) {
      rt.stopRequested = true;
      rt.poller?.stop();
      rt.poller = null;
    }
    const st = this.state(id);
    if (st.status === "running") {
      this.states.set(id, { ...st, status: "stopped", finishedAt: new Date().toISOString() });
    }
  }

  stopAll(): void {
    for (const bot of this.bots) this.stop(bot.id);
  }

  /** 并行启动多个机器人（回测模式并发跑，实时模式各起各的轮询）。 */
  async startMany(ids: string[]): Promise<BotState[]> {
    return Promise.all(ids.map((id) => this.start(id).catch(() => this.state(id))));
  }

  async startEnabled(): Promise<BotState[]> {
    return this.startMany(this.bots.filter((b) => b.enabled).map((b) => b.id));
  }

  // ---------------- 内部 ----------------

  /**
   * 该机器人在某一类模型上的专用客户端：只在其指定的实例范围内调度。
   * 混合决策时 chat / systemone 各拿一个，互不串味；某一类没选实例就返回 null（该路不参与）。
   */
  private clientFor(bot: BotConfig, kind: ModelKind): LLMClient | null {
    const ids = bot.modelProfileIds;
    const pool = this.llm.list().filter((p) => p.kind === kind && p.hasKey && p.enabled);
    const scoped = ids.length > 0 ? pool.filter((p) => ids.includes(p.id)) : pool;
    if (scoped.length === 0) return null;

    // 直接用管理器的调度/熔断/统计逻辑，限定在选定实例内
    const pick = (): LlmProfile => {
      const profile: LlmProfile | null = this.llm.pickAmong(scoped.map((p) => p.id));
      if (!profile) throw new Error(`机器人「${bot.name}」指定的${kind === "chat" ? "对话模型" : "决策模型"}实例当前不可用`);
      return profile;
    };
    const limited: LLMClient = {
      name: `bot:${kind}:${scoped.length}`,
      complete: async (prompt: string) => this.llm.completeWith(pick(), prompt),
      // 资产配置：System One 需要标的列表才能逐标的提问
      allocate: async (prompt: string, symbols: string[]) =>
        this.llm.allocateWith(pick(), prompt, symbols),
      // 原生 function calling（工具能力），同样限定在该机器人选定的实例内
      chat: async (messages, tools) => this.llm.chatWith(pick(), messages, tools),
    };
    return limited;
  }

  /**
   * 这个机器人是否真的会发真实订单。
   * 条件与单账户引擎一致：执行方式为真实下单 + 适配器支持交易 + 需要 Key 时必须已配置。
   * 任一条不满足就是模拟成交 —— 但那种情况已在 start() 里被拒绝（实时模式不允许降级）。
   */
  private resolveLiveTrading(bot: BotConfig, adapter: ExchangeAdapter): boolean {
    if (bot.mode !== "live") return false;
    if (this.config.execution.mode !== "live") return false;
    if (!adapter.meta.supportsTrading) return false;
    if (adapter.meta.requiresKeys && !this.connections.hasKey(bot.connectionId)) return false;
    return true;
  }

  /** 说清楚"为什么不能实盘"，而不是丢一句"不可用"。 */
  private liveBlockedReason(bot: BotConfig, adapter: ExchangeAdapter): string {
    if (this.config.execution.mode !== "live") return "「风控」页的执行方式仍是模拟成交";
    if (!adapter.meta.supportsTrading) return `连接「${this.connections.get(bot.connectionId)?.label ?? bot.connectionId}」不支持下单`;
    if (adapter.meta.requiresKeys && !this.connections.hasKey(bot.connectionId)) return "该连接还没有配置 API Key";
    return "实盘条件不满足";
  }

  /** 互斥：同一连接同时只允许一个实盘机器人。 */
  private assertLiveExclusive(bot: BotConfig): void {
    const busy = this.bots.find(
      (b) => b.id !== bot.id && b.connectionId === bot.connectionId && b.mode === "live" && this.state(b.id).status === "running",
    );
    if (busy) {
      throw new Error(
        `同一连接已有实盘机器人「${busy.name}」在运行；为避免并行下真单，同一连接同时只允许一个实盘机器人`,
      );
    }
  }

  /** 该机器人的全部决策路客户端。 */
  private lanesFor(bot: BotConfig): { chat: LLMClient | null; systemone: LLMClient | null } {
    return { chat: this.clientFor(bot, "chat"), systemone: this.clientFor(bot, "systemone") };
  }

  private buildRuntime(
    bot: BotConfig,
    adapter: ExchangeAdapter,
    lanes: { chat: LLMClient | null; systemone: LLMClient | null },
    liveTrading: boolean,
  ): Runtime {
    // 策略来自策略列表（按 id 引用），风险/模型间隔仍是机器人自己的
    const strategy = this.strategyOf(bot);
    const localConfig: AppConfig = {
      ...this.config,
      strategy: {
        ...this.config.strategy,
        decisionSource: strategy.decisionSource,
        fastWindow: strategy.fastWindow,
        slowWindow: strategy.slowWindow,
        maxTargetWeight: strategy.maxTargetWeight,
        selfAllocating: strategy.selfAllocating,
        maxPositions: strategy.maxPositions,
        maxGrossExposure: strategy.maxGrossExposure,
        allocationInterval: strategy.allocationInterval,
        hybridInfluence: strategy.hybridInfluence,
        hybridAnalysisTtlMs: strategy.hybridAnalysisTtlMs,
      },
      risk: { ...this.config.risk, ...bot.risk },
      llm: { ...this.config.llm, decisionInterval: bot.decisionInterval },
    };

    const journal = this.journalFor(bot);
    const pipeline = buildPipeline(localConfig, {
      adapter,
      // 实盘由 resolveLiveTrading() 判定并做了互斥；回测与降级情况一律本地撮合
      liveTrading,
      llm: lanes.chat,
      soClient: lanes.systemone,
      // 决策留痕：自我进化据此学习（与单账户引擎走的是同一份记录）
      ...(journal ? { journal } : {}),
    });

    // 行情必须打进 pipeline 自己的总线：
    // 策略/风控 Agent 都挂在 pipeline.bus 上、持有 pipeline.book，
    // 另起一份会导致「发了事件却没人接」或「风控查不到价格」。
    const bus = pipeline.bus;

    // 事件仅保留该机器人自己的
    const push = (event: Event): void => {
      if (event.topic === Topic.BAR || event.topic === Topic.MARKET_VIEW) return;
      const list = this.events.get(bot.id) ?? [];
      list.push({
        topic: event.topic,
        timestamp: new Date(event.timestamp).toISOString(),
        summary: summarize(event),
      });
      if (list.length > MAX_EVENTS_PER_BOT) list.shift();
      this.events.set(bot.id, list);
    };
    for (const topic of Object.values(Topic)) bus.subscribe(topic, push);

    const runtime: Runtime = { bus, pipeline, poller: null, stopRequested: false };
    this.runtimes.set(bot.id, runtime);
    return runtime;
  }

  private async runOnce(bot: BotConfig, rt: Runtime, adapter: ExchangeAdapter): Promise<void> {
    const started = Date.now();
    const groups = await Promise.all(
      bot.symbols.map((s) => adapter.fetchKlines(s, bot.interval, bot.barCount)),
    );
    const bars = mergeBarsByTime(groups);
    for (const bar of bars) {
      if (rt.stopRequested) break;
      await feed(rt.pipeline, [bar]);
      const st = this.state(bot.id);
      this.states.set(bot.id, {
        ...st,
        bars: st.bars + 1,
        durationMs: Date.now() - started,
        equityCurve: pushPoint(st.equityCurve, rt.pipeline.portfolio.equityCurve().at(-1)),
      });
    }
    this.states.set(bot.id, {
      ...this.state(bot.id),
      metrics: this.metricsOf(bot, rt),
      allocation: this.allocationOf(bot, rt),
      equityCurve: pushPoint(this.state(bot.id).equityCurve, rt.pipeline.portfolio.equityCurve().at(-1)),
      durationMs: Date.now() - started,
    });
  }

  private async runLive(bot: BotConfig, rt: Runtime, adapter: ExchangeAdapter): Promise<void> {
    const started = Date.now();
    // 预热
    const warm = await Promise.all(
      bot.symbols.map((s) => adapter.fetchKlines(s, bot.interval, bot.barCount)),
    );
    await feed(rt.pipeline, mergeBarsByTime(warm));
    this.states.set(bot.id, {
      ...this.state(bot.id),
      bars: warm.length,
      metrics: this.metricsOf(bot, rt),
      allocation: this.allocationOf(bot, rt),
      equityCurve: rt.pipeline.portfolio.equityCurve().slice(-CURVE_POINTS),
    });

    const poller = new LivePoller(adapter, rt.bus, rt.pipeline.book, {
      symbols: bot.symbols,
      interval: bot.interval,
      pollMs: bot.pollMs,
    });
    rt.poller = poller;
    poller.start((bars) => {
      void (async () => {
        if (rt.stopRequested) return;
        await feed(rt.pipeline, bars);
        const st = this.state(bot.id);
        this.states.set(bot.id, {
          ...st,
          bars: st.bars + bars.length,
          durationMs: Date.now() - started,
          metrics: this.metricsOf(bot, rt),
          allocation: this.allocationOf(bot, rt),
        });
        // 熔断：该机器人自己的回撤越限 -> 自动停
        if (rt.pipeline.portfolio.drawdownPct >= bot.risk.maxDrawdownPct) {
          log.warn("机器人「%s」回撤越限，自动停机", bot.name);
          this.stop(bot.id);
        }
      })();
    });
    log.info("机器人「%s」实时启动: %s", bot.name, bot.symbols.join(","));
  }

  /** 该账号此刻的资产配置：各标的市值权重 + 现金比例。 */
  private allocationOf(bot: BotConfig, rt: Runtime): BotAllocation {
    const equity = rt.pipeline.portfolio.equity();
    const cash = rt.pipeline.portfolio.cash;
    const holdings: BotHolding[] = rt.pipeline.portfolio
      .positionsSnapshot()
      .map((pos) => {
        const price = rt.pipeline.book.last(pos.symbol) ?? pos.avgCost;
        const marketValue = pos.quantity * price;
        return {
          symbol: pos.symbol,
          quantity: round8(pos.quantity),
          avgCost: round8(pos.avgCost),
          price: round8(price),
          marketValue: round2(marketValue),
          weight: equity > 0 ? round4(marketValue / equity) : 0,
          unrealizedPnl: round2((price - pos.avgCost) * pos.quantity),
        };
      })
      .sort((a, b) => b.marketValue - a.marketValue);
    return {
      timestamp: new Date().toISOString(),
      equity: round2(equity),
      cash: round2(cash),
      cashWeight: equity > 0 ? round4(cash / equity) : 1,
      holdings,
      heldCount: holdings.length,
    };
  }

  private metricsOf(bot: BotConfig, rt: Runtime): BotMetrics {
    const m = rt.pipeline.portfolio.metrics();
    const realized = rt.pipeline.portfolio.realizedPnl();
    return {
      ...m,
      realizedPnl: Number(realized.toFixed(4)),
      totalReturn: bot.risk.initialCash > 0 ? (m.finalEquity - bot.risk.initialCash) / bot.risk.initialCash : 0,
    };
  }

  private toView(bot: BotConfig): BotView {
    // 一眼看出「这个机器人由谁决策、用哪些模型实例」
    const labels: string[] = [];
    const kinds: ModelKind[] = bot.decisionSource === "hybrid" ? ["chat", "systemone"] : bot.decisionSource === "rules" ? [] : [bot.decisionSource];
    if (kinds.length === 0) {
      labels.push("双均线动量（量化交易）");
    }
    for (const kind of kinds) {
      const scoped = this.llm
        .list()
        .filter((p) => p.kind === kind && p.hasKey && p.enabled)
        .filter((p) => (bot.modelProfileIds.length > 0 ? bot.modelProfileIds.includes(p.id) : true));
      const zh = kind === "chat" ? "对话模型" : "决策模型";
      labels.push(
        scoped.length > 0
          ? `${zh}：${scoped.map((p) => p.label).join("/")}`
          : `${zh}：未配置可用实例`,
      );
    }
    return { ...bot, state: this.state(bot.id), modelLabels: labels };
  }
}

function round2(v: number): number {
  return Number(v.toFixed(2));
}
function round4(v: number): number {
  return Number(v.toFixed(4));
}
function round8(v: number): number {
  return Number(v.toFixed(8));
}

/** 追加一个权益点并裁掉超出部分；point 为空（还没成交）时不记。 */
function pushPoint(
  curve: { timestamp: string; equity: number }[],
  point?: { timestamp: string; equity: number },
): { timestamp: string; equity: number }[] {
  if (!point) return curve;
  const next = [...curve, point];
  return next.length > CURVE_POINTS ? next.slice(next.length - CURVE_POINTS) : next;
}

function freshState(id: string): BotState {
  return {
    id,
    status: "idle",
    startedAt: null,
    finishedAt: null,
    error: null,
    liveTrading: false,
    metrics: null,
    allocation: null,
    equityCurve: [],
    bars: 0,
    durationMs: 0,
    events: [],
  };
}

function summarize(event: Event): string {
  const p = event.payload as Record<string, unknown> | undefined;
  switch (event.topic) {
    case Topic.ALLOCATION: {
      const a = p as unknown as { weights: Record<string, number>; cashWeight: number; reason: string; source: string };
      const held = Object.entries(a.weights ?? {})
        .sort((x, y) => y[1] - x[1])
        .map(([s, w]) => `${s} ${(w * 100).toFixed(0)}%`)
        .join(" / ");
      return `[${a.source}] ${held || "空仓"} · 现金 ${((a.cashWeight ?? 0) * 100).toFixed(0)}% · ${a.reason}`;
    }
    case Topic.SIGNAL:
      return `信号 ${(p as { symbol: string }).symbol} weight=${(p as { targetWeight: number }).targetWeight}`;
    case Topic.ORDER_INTENT:
      return `${(p as { side: string }).side} ${(p as { symbol: string }).symbol}`;
    case Topic.FILL:
      return `成交 ${(p as { order?: { symbol?: string } })?.order?.symbol ?? ""} @ ${Number((p as { price: number }).price).toFixed(4)}`;
    case Topic.ORDER_REJECTED:
      return `拒单 ${(p as { symbol?: string })?.symbol ?? ""}`;
    default:
      return "";
  }
}

