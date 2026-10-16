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
import type { Bar } from "../core/types.js";
import type { Event } from "../core/eventBus.js";
import { LivePoller, mergeBarsByTime } from "../data/streaming.js";
import { getLogger } from "../core/logger.js";
import type { AppConfig, DecisionSource } from "../configSchema.js";
import { buildPipeline, feed, type Pipeline, type PipelineJournal } from "../agents/orchestrator.js";
import { PaperBroker } from "../execution/paperBroker.js";
import type { NewsService } from "../news/newsService.js";
import { toDigest, type NewsDigest } from "../news/types.js";
import { defaultToolBox, type ToolBox, type ToolContext } from "../llm/tools.js";
import type { LLMClient } from "../llm/llmClient.js";
import type { LlmManager, LlmProfile, ModelKind } from "../llm/llmManager.js";
import { StrategyStore, type StrategyProfile } from "../strategies/profileStore.js";
import type { EvolutionEngine } from "../evolution/engine.js";
import type { ExchangeAdapter } from "../exchanges/types.js";
import type { ConnectionManager } from "../exchanges/connectionManager.js";
import type {
  BotAction,
  BotAllocation,
  BotConfig,
  BotHolding,
  BotHistoryTotals,
  BotInput,
  BotMetrics,
  BotRunRecord,
  BotState,
  BotTrade,
  BotView,
} from "./types.js";

const log = getLogger("bots");
const MAX_EVENTS_PER_BOT = 120;

/** 成交流水最多保留多少条（新的在前）。 */
const MAX_TRADES_PER_BOT = 200;

/** 每个机器人最多保留多少次历史运行。 */
const MAX_RUNS_PER_BOT = 20;
/** 历史存档里每次运行保留多少笔成交（超出只留尾部，并标注已截断）。 */
const HISTORY_TRADES_PER_RUN = 60;
/** 历史存档里每次运行保留多少个曲线点。 */
const HISTORY_CURVE_POINTS = 120;
/** 运行中多久写一次存档快照（毫秒）：崩溃时最多丢这么多。 */
const CHECKPOINT_MS = 30_000;
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
  /** 预热中的机器人：预热只喂指标，事件/决策一律不记、不成交 */
  private readonly warmingUp = new Set<string>();
  /** 最新决策目标（symbol -> 权重），操作指引的依据 */
  private readonly latestTargets = new Map<
    string,
    { weights: Record<string, number>; reason: string; at: string }
  >();
  /**
   * 各标的的带时间戳 K 线（get_history 工具的数据源）。
   * 并行机器人看的是同一段行情，所以共用一份，不必每个机器人各存一份。
   */
  private readonly historyLog = new Map<string, { timestamp: string; close: number }[]>();
  /** 每根 K 线最多保留的历史长度 */
  private static readonly HISTORY_LIMIT = 400;
  /**
   * 运行存档：botId -> 历史运行（新 -> 旧）。
   * 落盘而非只在内存里 —— 机器人的意义在于长期战绩，重启即失等于没有战绩。
   */
  private runHistory = new Map<string, BotRunRecord[]>();
  /** 进行中的运行（用于收尾与定期快照） */
  private activeRun = new Map<string, BotRunRecord>();
  /** 快照节流：botId -> 上次写存档的时间戳 */
  private readonly runCheckpointAt = new Map<string, number>();

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
    /** 新闻情报：注入分析 prompt，并供只读工具箱查询。 */
    private readonly news?: NewsService,
  ) {
    this.load();
    this.loadHistory();
  }

  /**
   * 往分析 prompt 注入新闻摘要。
   * 与原单账户引擎同一套开关：enabled=false 或 includeInAnalysis=false 都不注入；
   * 在**调用时**判断，改配置后无需重启即可生效。
   * 模型主动用 search_news 工具查新闻的能力不受这里影响。
   */
  private newsFetcher(): (symbols: string[]) => Promise<NewsDigest[]> {
    return async (symbols: string[]) => {
      const svc = this.news;
      const cfg = this.config.news;
      if (!svc || !cfg.enabled || !cfg.includeInAnalysis) return [];
      const items = await svc.forSymbols(symbols).catch(() => []);
      return toDigest(items, Math.max(1, Math.floor(cfg.maxPerSymbol / 2)));
    };
  }

  /**
   * 该机器人的只读工具箱上下文。
   * 每个机器人有自己的 book/portfolio —— 工具必须反映"这个账户"的持仓，
   * 而不是全局某一次运行的残留。
   */
  private toolsFor(bot: BotConfig, runtime: () => Pipeline | undefined): { box: ToolBox; context: ToolContext } | undefined {
    if (!this.config.llm.agentEnabled) return undefined;
    const book = () => runtime()?.book;
    const portfolio = () => runtime()?.portfolio;
    const context: ToolContext = {
      candidates: () => bot.symbols,
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
        const initial = bot.risk.initialCash;
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
      // paperTrading 是后来加的字段：老数据没有时按"模拟成交"补齐 ——
      // 这个默认必须保守：把一个老机器人默认成真下单是不可接受的。
      if (typeof bot.paperTrading !== "boolean") {
        bot.paperTrading = true;
        changed = true;
      }
      // 机器人只做实时：旧的"回测机器人"改为实时 + 模拟成交。
      // 它本来就只在本地撮合（回测从不发真实订单），迁移不改变资金行为，
      // 只是不再让它冒充"跑历史的机器人"。
      if (bot.mode !== "live") {
        bot.mode = "live";
        bot.paperTrading = true;
        changed = true;
        log.info("机器人「%s」原为回测模式：已改为实时 + 模拟成交（历史模拟请用「回测」页）", bot.name);
      }
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

  // ---------------- 运行存档（跨重启保留） ----------------

  private get historyPath(): string {
    return join(this.dataDir, "bots-history.json");
  }

  private loadHistory(): void {
    if (!existsSync(this.historyPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.historyPath, "utf8")) as Record<string, BotRunRecord[]>;
      let staleFixed = false;
      for (const [botId, runs] of Object.entries(raw)) {
        if (!Array.isArray(runs)) continue;
        for (const r of runs) {
          // 上次进程留下的"运行中"存档：进程都没了，运行不可能还在。
          // 不标掉就是幽灵状态 —— 界面永远显示"运行中"，用户等到天荒地老。
          // 如实标记为中断，并保留最后的快照内容，不假装它跑完了。
          if (r.status === "running") {
            r.status = "error";
            r.error = "进程被中断，未正常结束（以下为最后保存的快照）";
            r.finishedAt = null;
            staleFixed = true;
          }
        }
        this.runHistory.set(botId, runs.slice(0, MAX_RUNS_PER_BOT));
      }
      if (staleFixed) this.persistHistory();
    } catch (err) {
      log.warn("bots-history.json 解析失败: %s", (err as Error).message);
    }
  }

  private persistHistory(): void {
    mkdirSync(this.dataDir, { recursive: true });
    const obj: Record<string, BotRunRecord[]> = {};
    for (const [botId, runs] of this.runHistory) {
      // 机器人已删除的存档不保留：留着就是幽灵数据，界面上也没有入口能解释它
      if (!this.bots.some((b) => b.id === botId)) continue;
      obj[botId] = runs;
    }
    writeFileSync(this.historyPath, JSON.stringify(obj), { mode: 0o600 });
  }

  /** 记一次运行开始。 */
  private beginRun(bot: BotConfig, liveTrading: boolean): void {
    const record: BotRunRecord = {
      id: randomUUID().slice(0, 8),
      botId: bot.id,
      name: bot.name,
      mode: bot.mode,
      paperTrading: bot.paperTrading,
      liveTrading,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: 0,
      bars: 0,
      symbols: [...bot.symbols],
      strategyName: this.strategyOf(bot).name,
      metrics: null,
      equityCurve: [],
      trades: [],
      tradesTruncated: false,
      pnlBySymbol: [],
      error: null,
    };
    const list = this.runHistory.get(bot.id) ?? [];
    list.unshift(record);
    this.runHistory.set(bot.id, list.slice(0, MAX_RUNS_PER_BOT));
    this.activeRun.set(bot.id, record);
    this.persistHistory();
  }

  /**
   * 把当前运行快照写进存档。
   * 定期调用：进程被杀/断电时，至少不会把整段运行丢掉。
   * 有节流，否则每次轮询都落盘会把磁盘写满。
   */
  private checkpointRun(bot: BotConfig, force = false): void {
    const record = this.activeRun.get(bot.id);
    const rt = this.runtimes.get(bot.id);
    if (!record || !rt) return;
    // 节流时间戳单独放在内存里：记在 record 上会算错（now - 累计耗时 恒小于阈值，
    // 结果是只写第一次，之后永远不发车）
    const now = Date.now();
    const last = this.runCheckpointAt.get(bot.id) ?? 0;
    if (!force && now - last < CHECKPOINT_MS) return;
    this.runCheckpointAt.set(bot.id, now);
    record.durationMs = now - new Date(record.startedAt).getTime();
    const st = this.state(bot.id);
    record.bars = st.bars;
    record.metrics = st.metrics;
    record.equityCurve = st.equityCurve.slice(-HISTORY_CURVE_POINTS);
    const total = st.metrics?.totalFills ?? 0;
    record.trades = st.trades.slice(0, HISTORY_TRADES_PER_RUN);
    record.tradesTruncated = total > record.trades.length;
    record.pnlBySymbol = st.pnlBySymbol;
    this.persistHistory();
  }

  /** 结束一次运行：状态写死并落盘（否则下次进来还挂着「运行中」的幽灵存档）。 */
  private endRun(bot: BotConfig, status: "stopped" | "error", error: string | null = null): void {
    const record = this.activeRun.get(bot.id);
    if (!record) return;
    // 顺序要紧：先把最终快照写进去，再摘掉 activeRun。
    // 反过来（先删后 checkpoint）会被 checkpointRun 的守卫挡掉，
    // 结果是存档永远停在预热那一刻 —— 战绩丢了，界面却显示"已停止"。
    this.checkpointRun(bot, true);
    this.activeRun.delete(bot.id);
    this.runCheckpointAt.delete(bot.id);
    record.status = status;
    record.error = error;
    record.finishedAt = new Date().toISOString();
    const st = this.state(bot.id);
    record.durationMs = st.durationMs || Date.now() - new Date(record.startedAt).getTime();
    this.persistHistory();
  }

  /**
   * 历史汇总。口径：只统计**正常结束**（stopped）的运行。
   * 中断/出错的运行不进汇总 —— 它的"收益"只是中断瞬间的中间值，
   * 算成胜场等于把没跑完的当成跑完。被中断的运行仍在列表里可见（状态标为出错）。
   * 各次运行独立从初始资金开始（不复利），累计盈亏是各次已实现盈亏之和。
   */
  private totalsOf(botId: string): BotHistoryTotals {
    const runs = this.runHistory.get(botId) ?? [];
    let wins = 0;
    let losses = 0;
    let cumulativeRealizedPnl = 0;
    let totalFills = 0;
    let bestReturn = Number.NEGATIVE_INFINITY;
    let worstReturn = Number.POSITIVE_INFINITY;
    for (const r of runs) {
      if (r.status !== "stopped" || !r.metrics) continue;
      const ret = r.metrics.totalReturn;
      if (ret > 0) wins += 1;
      else if (ret < 0) losses += 1;
      bestReturn = Math.max(bestReturn, ret);
      worstReturn = Math.min(worstReturn, ret);
      cumulativeRealizedPnl += r.metrics.realizedPnl;
      totalFills += r.metrics.totalFills;
    }
    const newest = runs[0];
    return {
      runs: runs.length,
      wins,
      losses,
      cumulativeRealizedPnl: round2(cumulativeRealizedPnl),
      totalFills,
      bestReturn: Number.isFinite(bestReturn) ? bestReturn : 0,
      worstReturn: Number.isFinite(worstReturn) ? worstReturn : 0,
      lastRunAt: newest ? (newest.finishedAt ?? newest.startedAt) : null,
    };
  }

  private historyOf(botId: string): BotRunRecord[] {
    return this.runHistory.get(botId) ?? [];
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
      // 默认模拟成交：让机器人先在真实行情上"干跑"，确认行为后再考虑实盘
      paperTrading: input.paperTrading ?? true,
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
    if (patch.paperTrading !== undefined) bot.paperTrading = patch.paperTrading;
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
    this.runHistory.delete(id);
    this.activeRun.delete(id);
    this.runCheckpointAt.delete(id);
    this.persist();
    this.persistHistory();
  }

  // ---------------- 运行 ----------------

  /**
   * 当前状态快照。
   *
   * 事件流单独存在 this.events（持续追加），不塞进状态对象 ——
   * 否则每根 K 线都要复制一次事件列表。这里在读取时合成，
   * 并且按「新的在前」返回（界面的事件日志就是按这个顺序渲染的）。
   */
  state(id: string): BotState {
    const st = this.states.get(id) ?? freshState(id);
    const log = this.events.get(id);
    if (!log || log.length === 0) return st;
    // 按时间倒序（新的在前）：事件的到达顺序与 K 线时刻未必一致
    // （同一根 K 线里多个事件、拒单回溯等），界面按这个顺序渲染。
    return { ...st, events: [...log].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)) };
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
    /**
     * 实时模式有两种跑法，边界必须清楚：
     * - 实盘（liveTrading=true）：paperTrading=false 且四条件齐备。任一不满足**拒绝启动**，
     *   不悄悄降级 —— 用户以为钱打出去了实际没动，是最糟的结局。
     * - 模拟成交（liveTrading=false）：行情照真拉，撮合在本地，零资金风险。
     *   这是默认跑法：机器人跟着真实市场干跑，统计盈亏，验证行为。
     */
    const wantsReal = bot.mode === "live" && !bot.paperTrading;
    const liveTrading = wantsReal ? this.resolveLiveTrading(bot, adapter) : false;
    if (wantsReal && !liveTrading) {
      throw new Error(`机器人「${bot.name}」设为真实下单，但${this.liveBlockedReason(bot, adapter)}；不会启动`);
    }
    // 同一连接同时只允许一个实盘机器人，避免并行下真单（模拟成交不受限）
    if (liveTrading) this.assertLiveExclusive(bot);

    const runtime = this.buildRuntime(bot, adapter, this.lanesFor(bot), liveTrading);

    this.states.set(id, {
      ...freshState(id),
      liveTrading,
      status: "running",
      startedAt: new Date().toISOString(),
    });
    if (liveTrading) {
      log.warn("机器人「%s」进入实盘：订单将真实发往交易所", bot.name);
    } else if (bot.mode === "live") {
      log.info("机器人「%s」实时启动（模拟成交）：行情真实、撮合在本地，零资金风险", bot.name);
    }
    this.beginRun(bot, liveTrading);

    try {
      // 机器人只有实时一种跑法：决策来自实时行情，成交随实时 K 线产生。
      // 历史数据模拟（跑一段历史看策略表现）不属于机器人，在「回测」页做。
      await this.runLive(bot, runtime, adapter);
      // runLive 预热完、启动轮询器就返回，机器人**仍在运行**。
      // 绝不能在这里标 stopped —— 轮询器还在跑，标了就是假状态，
      // 还会让 isRunning() 误判、允许对同一个机器人叠着启动第二个轮询器。
      return this.state(id);
    } catch (err) {
      this.states.set(id, {
        ...this.state(id),
        status: "error",
        error: (err as Error).message,
        finishedAt: new Date().toISOString(),
      });
      this.endRun(bot, "error", (err as Error).message);
      log.error("机器人「%s」异常: %s", bot.name, (err as Error).message);
      return this.state(id);
    }
  }

  stop(id: string): void {
    const bot = this.get(id);
    if (!bot) return;
    const rt = this.runtimes.get(id);
    if (rt) {
      rt.stopRequested = true;
      rt.poller?.stop();
      rt.poller = null;
    }
    const st = this.state(id);
    if (st.status === "running") {
      this.states.set(id, { ...st, status: "stopped", finishedAt: new Date().toISOString() });
      this.endRun(bot, "stopped");
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

  /** 拆单执行统计（paper 券商 + 已开拆单时才有）。 */
  private slicingOf(bot: BotConfig): { slicing?: BotView["slicing"] } {
    const rt = this.runtimes.get(bot.id);
    const broker = rt?.pipeline.broker;
    if (!(broker instanceof PaperBroker)) return {};
    const st = broker.slicingState();
    if (!st) return {};
    const done = st.completed;
    return {
      slicing: {
        algo: st.algo,
        slices: st.slices,
        completed: done.length,
        pending: st.pending.length,
        avgShortfallBps:
          done.length > 0 ? Number((done.reduce((a, o) => a + o.shortfallBps, 0) / done.length).toFixed(4)) : 0,
      },
    };
  }

  /** 记录带时间戳的 K 线（给 get_history 工具用）。 */
  private trackHistory(bar: Bar): void {
    const list = this.historyLog.get(bar.symbol) ?? [];
    list.push({ timestamp: bar.timestamp.toISOString(), close: bar.close });
    if (list.length > BotManager.HISTORY_LIMIT) list.shift();
    this.historyLog.set(bar.symbol, list);
  }

  /** 该机器人的全部决策路客户端。 */
  /**
   * 该机器人可用的决策路客户端。
   *
   * 量化交易（rules）时**一律返回 null**：界面上写着「完全不调用模型」，
   * 这里就必须一个请求都不发 —— 包括点评 Agent 那条旁路，
   * 否则会出现"说是纯规则、其实在偷偷调模型"。
   */
  private lanesFor(bot: BotConfig): { chat: LLMClient | null; systemone: LLMClient | null } {
    if (this.strategyOf(bot).decisionSource === "rules") return { chat: null, systemone: null };
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
    const runtimeRef: { current?: Pipeline } = {};
    const tools = this.toolsFor(bot, () => runtimeRef.current);
    const pipeline = buildPipeline(localConfig, {
      adapter,
      // 实盘由 resolveLiveTrading() 判定并做了互斥；回测与降级情况一律本地撮合
      liveTrading,
      llm: lanes.chat,
      soClient: lanes.systemone,
      // 新闻摘要：只进 prompt，不直接触发交易
      news: this.newsFetcher(),
      // 决策留痕：自我进化据此学习
      ...(journal ? { journal } : {}),
      // 只读工具箱：让模型自己查新闻/走势/当前配置
      ...(tools ? { tools } : {}),
    });
    runtimeRef.current = pipeline;

    // 行情必须打进 pipeline 自己的总线：
    // 策略/风控 Agent 都挂在 pipeline.bus 上、持有 pipeline.book，
    // 另起一份会导致「发了事件却没人接」或「风控查不到价格」。
    const bus = pipeline.bus;

    // 事件仅保留该机器人自己的
    const push = (event: Event): void => {
      if (event.topic === Topic.BAR || event.topic === Topic.MARKET_VIEW) return;
      // 预热期间的事件一律不记：那是历史回放触发的决策，
      // 记进事件日志等于声称"机器人一启动就做了这么多决策"。
      if (this.warmingUp.has(bot.id)) return;
      // 捕获最新目标权重：人工模仿用的操作指引就是由它算出来的
      if (event.topic === Topic.ALLOCATION) {
        const a = event.payload as unknown as {
          weights: Record<string, number>;
          reason: string;
          timestamp: Date | string;
        };
        this.latestTargets.set(bot.id, {
          weights: a.weights ?? {},
          reason: a.reason ?? "",
          at: new Date(a.timestamp ?? event.timestamp).toISOString(),
        });
      }
      if (event.topic === Topic.SIGNAL) {
        const s = event.payload as unknown as {
          symbol: string;
          targetWeight: number;
          reason: string;
          timestamp: Date | string;
        };
        const prev = this.latestTargets.get(bot.id);
        const weights = { ...(prev?.weights ?? {}) };
        weights[s.symbol] = s.targetWeight;
        this.latestTargets.set(bot.id, {
          weights,
          reason: s.reason ?? prev?.reason ?? "",
          at: new Date(s.timestamp ?? event.timestamp).toISOString(),
        });
      }
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

  private async runLive(bot: BotConfig, rt: Runtime, adapter: ExchangeAdapter): Promise<void> {
    const started = Date.now();
    /**
     * 预热：把历史 K 线喂进各 Agent 的缓冲区，但**不决策、不成交**。
     *
     * 这台机器人的交易统计必须来自它实时接到的每一根新 K 线。
     * 历史上这里的做法是把整段历史直接灌进流水线，启动瞬间就产生几十笔
     * "历史成交" —— 那是回放，不是这台机器人在实时的作为；
     * 用它统计盈亏、甚至照着人工模仿，模仿的是一段与实时无关的回放。
     */
    const warmBars = mergeBarsByTime(
      await Promise.all(bot.symbols.map((s) => adapter.fetchKlines(s, bot.interval, bot.barCount))),
    );
    // 历史 K 线照样进 historyLog（get_history 工具的数据源）——
    // 只是不决策、不成交。工具看到的是真实行情，与预热是否成交无关。
    for (const bar of warmBars) this.trackHistory(bar);
    this.warmingUp.add(bot.id);
    rt.pipeline.primeMode = true;
    try {
      await feed(rt.pipeline, warmBars);
    } finally {
      rt.pipeline.primeMode = false;
      this.warmingUp.delete(bot.id);
    }
    const warmTrades = this.tradesOf(rt).length;
    if (warmTrades > 0) {
      // 预热不该产生任何成交；真出现了说明闸门漏了，必须吵醒而不是悄悄放过
      log.error("机器人「%s」预热期间产生 %d 笔成交（不应发生）", bot.name, warmTrades);
    }
    this.states.set(bot.id, {
      ...this.state(bot.id),
      bars: 0,
      warmupBars: warmBars.length,
      metrics: this.metricsOf(bot, rt),
      allocation: this.allocationOf(bot, rt),
      equityCurve: [],
      trades: [],
      pnlBySymbol: [],
    });
    this.checkpointRun(bot, true);

    const poller = new LivePoller(adapter, rt.bus, rt.pipeline.book, {
      symbols: bot.symbols,
      interval: bot.interval,
      pollMs: bot.pollMs,
    });
    rt.poller = poller;
    poller.start((bars) => {
      void (async () => {
        if (rt.stopRequested) return;
        for (const bar of bars) this.trackHistory(bar);
        await feed(rt.pipeline, bars);
        if (rt.stopRequested) return; // 再检一次：stop 可能在 feed 期间被调用
        const st = this.state(bot.id);
        this.states.set(bot.id, {
          ...st,
          bars: st.bars + bars.length,
          durationMs: Date.now() - started,
          metrics: this.metricsOf(bot, rt),
          allocation: this.allocationOf(bot, rt),
          equityCurve: rt.pipeline.portfolio.equityCurve().slice(-CURVE_POINTS),
          trades: this.tradesOf(rt),
          pnlBySymbol: this.pnlBySymbol(rt),
          actions: this.actionsOf(bot, rt),
        });
        this.checkpointRun(bot);
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
    const target = this.latestTargets.get(bot.id);
    // 最新价表：候选池里的标的都要有价，否则操作指引无从换算
    const prices: Record<string, number> = {};
    for (const symbol of new Set([...bot.symbols, ...holdings.map((h) => h.symbol)])) {
      const price = rt.pipeline.book.last(symbol);
      if (price !== undefined) prices[symbol] = round8(price);
    }
    return {
      timestamp: new Date().toISOString(),
      equity: round2(equity),
      cash: round2(cash),
      cashWeight: equity > 0 ? round4(cash / equity) : 1,
      holdings,
      heldCount: holdings.length,
      targets: target?.weights ?? {},
      decidedAt: target?.at ?? null,
      reason: target?.reason ?? "",
      prices,
    };
  }

  /**
   * 仓位调整指引：把机器人的目标仓位换算成"人可以照着手动下单"的操作。
   *
   * 这是模拟盘相对实盘唯一差别（不下单）的直接产物：既然决策与实盘一致，
   * "还差多少才到位"就能精确算出来。不敢全权交给机器人、或交易所不支持
   * API 交易时，照着这份清单在自己的交易软件里操作即可。
   *
   * 诚实原则：
   * - 没有目标权重（还没出决策）时不下结论，明确说"暂无决策"；
   * - 差额小于最小调仓额的不给操作（机器人自己也不会动）；
   * - 拿不到价格的标的说明原因，不脑补数量。
   */
  private actionsOf(bot: BotConfig, rt: Runtime): BotAction[] {
    const target = this.latestTargets.get(bot.id);
    const alloc = this.allocationOf(bot, rt);
    if (!target) return [];
    const equity = alloc.equity;
    if (!(equity > 0)) return [];
    const bySymbol = new Map(alloc.holdings.map((h) => [h.symbol, h]));
    const symbols = new Set([...Object.keys(target.weights), ...bySymbol.keys()]);
    const actions: BotAction[] = [];
    for (const symbol of symbols) {
      const price = alloc.prices[symbol];
      const holding = bySymbol.get(symbol);
      const currentWeight = holding?.weight ?? 0;
      const targetWeight = Math.max(0, Math.min(1, target.weights[symbol] ?? 0));
      const holdingQty = holding?.quantity ?? 0;
      // 目标持仓：目标权重对应的股数（供人对照"买到多少算到位"）
      const targetQty = price ? (targetWeight * equity) / price : 0;
      if (price === undefined) {
        actions.push({
          symbol,
          side: "HOLD",
          quantity: 0,
          price: 0,
          value: 0,
          fromWeight: currentWeight,
          toWeight: targetWeight,
          holdingQty,
          targetQty: 0,
          reason: target.reason,
          at: target.at,
          note: "暂无行情价，无法换算数量",
        });
        continue;
      }
      const deltaValue = (targetWeight - currentWeight) * equity;
      const quantity = Math.abs(deltaValue) / price;
      const minTrade = bot.risk.minTradeValue;
      if (Math.abs(deltaValue) < minTrade || quantity <= 0) {
        // 差额在噪声内：机器人自己也不会调，指引就不该怂恿人去动
        actions.push({
          symbol,
          side: "HOLD",
          quantity: 0,
          price: round8(price),
          value: 0,
          fromWeight: currentWeight,
          toWeight: targetWeight,
          holdingQty,
          targetQty: round8(targetQty),
          reason: target.reason,
          at: target.at,
          note: "差额小于最小调仓额，无需操作",
        });
        continue;
      }
      actions.push({
        symbol,
        side: deltaValue > 0 ? "BUY" : "SELL",
        quantity: round8(quantity),
        price: round8(price),
        value: round2(Math.abs(deltaValue)),
        fromWeight: currentWeight,
        toWeight: targetWeight,
        holdingQty,
        targetQty: round8(targetQty),
        reason: target.reason,
        at: target.at,
      });
    }
    // 有操作的排前面，按金额从大到小
    return actions.sort((a, b) => {
      if ((a.side === "HOLD") !== (b.side === "HOLD")) return a.side === "HOLD" ? 1 : -1;
      return b.value - a.value;
    });
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

  /** 成交流水（新->旧，只留尾部若干条），交易统计的明细来源。 */
  private tradesOf(rt: Runtime): BotTrade[] {
    return rt.pipeline.portfolio
      .tradeHistory()
      .slice(0, MAX_TRADES_PER_BOT)
      .map((t) => ({
        id: t.id,
        timestamp: t.timestamp,
        symbol: t.symbol,
        side: t.side,
        quantity: round8(t.quantity),
        price: round8(t.price),
        fee: round4(t.fee),
        realizedPnl: round2(t.realizedPnl),
        reason: t.reason,
      }));
  }

  /** 各标的的已实现盈亏合计 + 成交笔数："哪个标的在赚钱"一眼可见。 */
  private pnlBySymbol(rt: Runtime): { symbol: string; realizedPnl: number; fills: number }[] {
    const bySymbol = new Map<string, { realizedPnl: number; fills: number }>();
    for (const t of rt.pipeline.portfolio.tradeHistory()) {
      const agg = bySymbol.get(t.symbol) ?? { realizedPnl: 0, fills: 0 };
      agg.realizedPnl += t.realizedPnl;
      agg.fills += 1;
      bySymbol.set(t.symbol, agg);
    }
    return [...bySymbol.entries()]
      .map(([symbol, agg]) => ({ symbol, realizedPnl: round2(agg.realizedPnl), fills: agg.fills }))
      .sort((a, b) => b.realizedPnl - a.realizedPnl);
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
    return {
      ...bot,
      state: this.state(bot.id),
      modelLabels: labels,
      history: this.historyOf(bot.id),
      totals: this.totalsOf(bot.id),
      ...this.slicingOf(bot),
    };
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
    warmupBars: 0,
    durationMs: 0,
    events: [],
    trades: [],
    pnlBySymbol: [],
    actions: [],
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
      // 没专门写摘要的事件也要看得懂：返回空串会在事件日志里留下空白行，
      // 用户看到"有事件但什么都没写"，只会以为是坏了。
      return describePayload(event.topic, p);
  }
}

/** 兜底摘要：主题 + 几个基本类型字段（数量/字符串/布尔），够看懂发生了什么。 */
function describePayload(topic: string, p: Record<string, unknown> | undefined): string {
  const fields = Object.entries(p ?? {})
    .filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean")
    .slice(0, 3)
    .map(([k, v]) => {
      const text = typeof v === "number" ? String(Number(v.toFixed(4))) : String(v);
      return `${k}=${text.slice(0, 24)}`;
    })
    .join(" ");
  return fields ? `${topic} ${fields}` : topic;
}

