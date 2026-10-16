/**
 * 全局状态与模拟对照的编排者。
 *
 * 单账户运行引擎删除后，这里不再"跑"任何交易，只剩三件事：
 * - 维护全局状态（生效配置、候选池行情、对照结果）并广播给界面
 * - 策略列表的增删改查（把默认策略并进生效配置）
 * - 模拟对照：装配参赛者、跑并行模拟盘、汇总战绩
 *
 * 交易本身一律走机器人（/api/bots），别在这里再加第二条交易路径。
 */

import type { AppConfig } from "../configSchema.js";
import { redactConfig } from "../configSchema.js";
import { getLogger } from "../core/logger.js";
import { strategyFields, StrategyStore, type StrategyProfile, type StrategyProfileInput } from "../strategies/profileStore.js";
import type { ExchangeAdapter, Ticker } from "../exchanges/types.js";

/**
 * 候选池行情：交易所行情 + 它来自哪个连接。
 *
 * 候选池里同一个代码可能出现在多个连接上（币安的 BTCUSDT 与某美股代码不会重名，
 * 但两个连接都添同一个代码是允许的），界面按连接分开显示时要有这个字段才分得清。
 */
export type StateTicker = Ticker & { connectionId: string };
import type { ConnectionManager } from "../exchanges/connectionManager.js";
import type { WatchlistManager } from "../watchlist.js";
import type { LlmManager } from "../llm/llmManager.js";
import type { NewsService } from "../news/newsService.js";
import type { EvolutionEngine } from "../evolution/engine.js";
import type { BotConfig } from "../bots/types.js";
import { runComparison, type ComparisonResult } from "../bench/comparison.js";
import { buildParticipants, resolveRunners, MAX_RUNNERS, type Participant } from "../bench/participants.js";

const log = getLogger("engine");


/**
 * 全局状态。
 *
 * 这里**不再**包含任何"某一次运行"的指标/持仓/流水 —— 那些都在机器人那边
 * （/api/bots）。这里只剩：配置、候选池行情、模拟对照结果。
 */
export interface EngineState {
  /** 候选池行情 */
  tickers: StateTicker[];
  /** 最近一次模拟对照结果 */
  comparison: ComparisonResult | null;
  /** 对照实验进行中 */
  comparing: boolean;
  /** 生效中的配置（已脱敏） */
  config: Record<string, unknown>;
  /**
   * "现在开跑会跑什么"：连接、周期、标的。
   * 界面上要显示标的时一律用这个，不要在前端自己猜 ——
   * 猜出来的列表与服务端按连接过滤后的结果经常不一致（自选里混着别的连接的标的），
   * 就会出现"页面上写着 1 个标的，一跑就报没有可运行的标的"。
   */
  runTarget: RunTarget;
}

export interface RunTarget {
  connectionId: string | null;
  connectionLabel: string | null;
  /** 适配器 id（如 simulated）：界面据此说明"这次跑在随机行情上" */
  connectionAdapterId: string | null;
  interval: string;
  symbols: string[];
  /** 解析不出标的时的原因（能跑则为 null） */
  error: string | null;
  /**
   * 标的由交易所自带（模拟交易所），用户不需要选。
   * 界面据此不再展示/要求挑选标的 —— 选出来的东西跟模拟行情无关。
   */
  symbolsBuiltIn: boolean;
}

export type Broadcast = { type: "state"; data: EngineState };

export class EngineController {
  private state: EngineState;
  private listeners = new Set<(b: Broadcast) => void>();

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
    /**
     * 机器人管理器：只用于"拿配置好的机器人当对照参赛者"。
     * 不传（单测/一次性实验）时参赛者清单里就没有机器人。
     */
    private readonly bots?: { list: () => BotConfig[]; strategyOf: (bot: BotConfig) => StrategyProfile },
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
    // runTarget 是派生值，每次现算：连接和候选池随时会变，存一份就会出现
    // 「界面说跑不了、其实能跑」—— 首次启动时连接是在控制器建好之后才创建的，
    // 存下来的那份永远停在"尚未配置任何交易所连接"。
    this.state.runTarget = this.safeRunTarget();
    return { ...this.state, config: redactConfig(this.config) };
  }

  getConfig(): AppConfig {
    return this.config;
  }

  /** 取某个连接的适配器（不存在会抛错）。实时运行与行情刷新用它 —— 同一个世界。 */
  adapter(connectionId: string): ExchangeAdapter {
    return this.connections.adapter(connectionId);
  }

  /**
   * 一次性历史运行（回测/对照）专用的独立实例。
   *
   * 它们会调用 `newScenario()` 掷一条新路径，不能掷在实时机器人正在用的那个
   * 实例上（否则机器人行情出现断层）。见 ConnectionManager.independentAdapter。
   */
  independentAdapter(connectionId: string): ExchangeAdapter {
    return this.connections.independentAdapter(connectionId);
  }

  private freshState(): EngineState {
    return {
      tickers: [],
      comparison: null,
      comparing: false,
      config: redactConfig(this.config),
      runTarget: this.safeRunTarget(),
    };
  }

  private emitState(): void {
    this.broadcast({ type: "state", data: this.snapshot() });
  }


  // ---------------- 行情快照 ----------------

  /**
   * 拉取候选池行情（策略页「候选池行情」）。
   *
   * 只按候选池取：候选池是"允许交易哪些标的"的唯一来源，行情也就只有这一份。
   * 「自带标的」的连接（模拟交易所）不进这里 —— 它的标的由它自己编，
   * 拿它们当行情列出来，看起来就像真有一批标的在报价。
   */
  async refreshTickers(): Promise<StateTicker[]> {
    const byConnection = new Map<string, string[]>();
    for (const item of this.watchlist.list()) {
      const list = byConnection.get(item.connectionId) ?? [];
      if (!list.includes(item.symbol)) list.push(item.symbol);
      byConnection.set(item.connectionId, list);
    }
    if (byConnection.size === 0) return [];
    const out: StateTicker[] = [];
    for (const [connectionId, symbols] of byConnection) {
      try {
        const adapter = this.connections.adapter(connectionId);
        for (const t of await adapter.fetchTickers(symbols)) out.push({ ...t, connectionId });
      } catch (err) {
        log.warn("行情刷新失败[%s]: %s", connectionId, (err as Error).message);
      }
    }
    this.state.tickers = out;
    return out;
  }

  // ---------------- 运行控制 ----------------

  /**
   * 解析「验证类」请求要用的运行目标：连接、周期、候选池标的。
   * 前推验证与稳健性体检都在这里复用，保证和真正跑回测用的是同一套标的。
   */
  resolveRunTarget(connectionId?: string, symbols?: string[]): {
    connection: { id: string; label: string; adapterId: string };
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

  private resolveConnection(connectionId?: string): { id: string; label: string; adapterId: string } {
    const connections = this.connections.list();
    if (connections.length === 0) {
      throw new Error("尚未配置任何交易所连接，请先在「交易所」页添加连接");
    }
    const id = connectionId || this.config.execution.connectionId || connections[0]!.id;
    const found = connections.find((c) => c.id === id);
    if (!found) throw new Error(`连接不存在: ${id}`);
    return { id: found.id, label: found.label, adapterId: found.adapterId };
  }

  private resolveSymbols(connectionId: string, requested?: string[]): string[] {
    if (requested && requested.length > 0) return requested;
    // 自带标的的交易所（模拟交易所）：标的由交易所定，候选池对它无效。
    // 行情都是它自己编的，还要人先配一套标的代码才能跑，纯属多余。
    const builtin = this.builtinSymbolsOf(connectionId);
    if (builtin.length > 0) return builtin;
    const fromConfig = this.config.market.symbols.filter(Boolean);
    if (fromConfig.length > 0) return fromConfig;
    const fromWatchlist = this.watchlist
      .list()
      .filter((w) => w.connectionId === connectionId)
      .map((w) => w.symbol);
    if (fromWatchlist.length > 0) return fromWatchlist;
    throw new Error("没有可运行的标的：请在「策略 → 候选池」添加，或换到模拟交易所（它自带仓位槽，不用挑）");
  }

  /** 交易所自带的标的集合；不是这种交易所（或取不到）时返回空数组。 */
  private builtinSymbolsOf(connectionId: string): string[] {
    try {
      const meta = this.connections.adapter(connectionId).meta;
      if (!meta.builtinSymbols) return [];
      return (meta.defaultSymbols ?? []).map((s) => s.symbol);
    } catch {
      return [];
    }
  }

  /**
   * 参赛者清单：机器人 / 量化策略 / 模型实例 / 动量基线，摊平成一张表。
   * 界面只勾 key，能勾哪些、为什么不能勾都由这里说了算 —— 避免"勾了跑不了"。
   */
  listParticipants(): Participant[] {
    const target = this.safeRunTarget();
    return buildParticipants({
      defaultStrategy: this.strategies.default(),
      strategies: this.strategies.list(),
      bots: this.bots?.list() ?? [],
      strategyOf: (bot) => this.bots?.strategyOf(bot) ?? this.strategies.default(),
      llm: this.llm,
      connectionId: target.connectionId ?? "",
      connectionLabel: target.connectionLabel ?? "（未选择）",
    });
  }

  /** 解析不出标的也不抛异常：参赛者清单要照常返回，只是把原因带出去。 */
  private safeRunTarget(): RunTarget {
    try {
      const t = this.resolveRunTarget();
      return {
        connectionId: t.connection.id,
        connectionLabel: t.connection.label,
        connectionAdapterId: t.connection.adapterId,
        interval: t.interval,
        symbols: t.symbols,
        error: null,
        symbolsBuiltIn: this.builtinSymbolsOf(t.connection.id).length > 0,
      };
    } catch (err) {
      return {
        connectionId: null,
        connectionLabel: null,
        connectionAdapterId: null,
        interval: this.config.market.interval,
        symbols: [],
        error: (err as Error).message,
        symbolsBuiltIn: false,
      };
    }
  }

  /**
   * 模拟对照：同一份行情、同一套风控与初始资金，多个选手各自独立操盘独立记账。
   * 选手可以是机器人、量化策略或模型实例 —— 比的是"谁的决策更赚钱"。
   */
  async runSimulationComparison(options: {
    /** 参赛者 key 列表（baseline / bot:… / strategy:… / model:…） */
    keys: string[];
    bars?: number;
    symbols?: string[];
    interval?: string;
    /** 复现用：指定随机情景种子（仅模拟交易所有效） */
    scenarioSeed?: number;
  }): Promise<ComparisonResult> {
    if (this.state.comparing) {
      throw new Error("对照实验正在进行中");
    }
    const keys = (options.keys ?? []).filter(Boolean);
    if (keys.length === 0) throw new Error("还没有勾选任何参赛者");
    if (keys.length > MAX_RUNNERS) {
      throw new Error(`参赛者最多 ${MAX_RUNNERS} 个（当前 ${keys.length} 个）：流水线并行跑，时间会线性变长`);
    }
    this.state.comparing = true;
    this.emitState();

    // 解析标的、装配选手都放进 try：任何一步抛错都必须把 comparing 复位。
    // 以前解析标的在 try 之外，失败一次就把 comparing 永久留在 true ——
    // 表现为"第一次失败后，这个功能再也点不动了，直到重启服务"。
    try {
      const target = this.resolveRunTarget(undefined, options.symbols);
      const runners = resolveRunners(keys, {
        defaultStrategy: this.strategies.default(),
        strategies: this.strategies.list(),
        bots: this.bots?.list() ?? [],
        strategyOf: (bot) => this.bots?.strategyOf(bot) ?? this.strategies.default(),
        llm: this.llm,
        connectionId: target.connection.id,
        connectionLabel: target.connection.label,
      });

      const result = await runComparison(this.config, {
        // 独立实例：对照掷新路径，但不能掷到实时机器人脚下的行情上
        adapter: this.connections.independentAdapter(target.connection.id),
        symbols: target.symbols,
        bars: options.bars ?? this.config.market.barCount,
        interval: options.interval ?? target.interval,
        liveTrading: false, // 对照实验始终用本地模拟成交，避免动真钱
        runners,
        ...(options.scenarioSeed !== undefined ? { scenarioSeed: options.scenarioSeed } : {}),
      });
      // 行情连接名一并给出：让人知道这份名次的数据来自哪儿
      const withSource = { ...result, connectionLabel: target.connection.label };
      this.state.comparison = withSource;
      return withSource;
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

/** 事件 -> 一行摘要。 */
/** 决策来源 -> 对应的模型池类型；纯规则/无模型时为 null。 */
function modelKindOf(source: string): "chat" | "systemone" | null {
  if (source === "chat" || source === "hybrid") return "chat";
  if (source === "systemone") return "systemone";
  return null;
}

