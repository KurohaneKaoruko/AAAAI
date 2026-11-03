/**
 * 资产配置 Agent：BAR -> ALLOCATION -> 若干 SIGNAL（由 AI 自己选资产配权重）。
 *
 * 触发时机：每「一轮」行情只决策一次（多标的时间对齐的一组 K 线算一轮），
 * 避免同一次行情被决策 N 次；再按 interval 做节流。
 *
 * 输出拆解为逐标的 Signal 后交给既有风控链路，因此：
 * 仓位上限、单笔上限、最小调仓额、回撤熔断依旧生效，无需为配置模式另写一套风控。
 */

import type { EventBus } from "../core/eventBus.js";
import { Topic } from "../core/eventBus.js";
import type { Allocation, Bar, MarketView, Signal } from "../core/types.js";
import { getLogger } from "../core/logger.js";
import type { PortfolioManager } from "../portfolio/portfolioManager.js";
import type { AllocationLimits, AssetSnapshot } from "../llm/allocation.js";
import { describeAllocation } from "../llm/allocation.js";
import type { AllocationResult } from "../strategies/allocator.js";
import { Agent, type Subscription } from "./agent.js";

const log = getLogger("agent:allocator");

const BUFFER = 200;

/** 资产配置器只需实现 allocate，规则基线 / AI / 多路融合都能塞进来。 */
export interface AssetAllocator {
  allocate(snapshots: AssetSnapshot[]): Promise<AllocationResult>;
}

/** 逐标的决策的回调（混合决策下：分析一次，再逐标的让决策模型定档位）。 */
export interface PerSymbolDecision {
  weights: Record<string, number>;
  confidence: number;
  reason: string;
}

export interface AllocatorOptions {
  fastWindow: number;
  slowWindow: number;
  /** 每 N 轮行情决策一次 */
  interval: number;
  /** 至少累积多少根 K 线才允许决策 */
  warmup: number;
  limits: AllocationLimits;
  allocator: AssetAllocator;
  portfolio: PortfolioManager;
  /** 给了它就走逐标的决策（不走资产配置器） */
  perSymbolDecide?: (snapshots: AssetSnapshot[]) => Promise<PerSymbolDecision>;
  /** 决策留痕（自我进化用） */
  journal?: (entry: {
    source: string;
    weights: Record<string, number>;
    cashWeight: number;
    confidence: number;
    reason: string;
    entryBarIndex: number;
  }) => void;
  /**
   * 预热闸门：返回 true 时本轮不决策（K 线已进缓冲区，只是不产生配置/下单/留痕）。
   * 实时机器人靠它把"启动时的历史"与"实时收到的行情"分开。
   */
  gate?: () => boolean;
}

export class AllocatorAgent extends Agent {
  readonly name = "allocator";

  private readonly bars = new Map<string, Bar[]>();
  private readonly views = new Map<string, MarketView>();
  /** 本轮已收到的 K 线所属标的 */
  private round = new Set<string>();
  /** 当前轮的时间戳（本轮第一根 K 线的时间），决策用它打时间戳 */
  private roundTs: Date | undefined;
  /** 上一轮的标的集合，用来判断本轮是否收齐 */
  private expected = new Set<string>();
  /** 已完成的有效轮次（预热未结束不计），用于按 interval 节流 */
  private rounds = 0;
  private busy = false;
  /** 已处理的 K 线总数，供结算判断 horizon 是否到期 */
  private barsSeen = 0;

  constructor(
    bus: EventBus,
    private readonly opts: AllocatorOptions,
  ) {
    super(bus);
  }

  protected subscriptions(): Subscription[] {
    return [
      { topic: Topic.BAR, handler: (e) => this.onBar(e.payload as Bar) },
      { topic: Topic.MARKET_VIEW, handler: (e) => this.onMarketView(e.payload as MarketView) },
    ];
  }

  private onMarketView(view: MarketView): void {
    this.views.set(view.symbol, view);
  }

  private async onBar(bar: Bar): Promise<void> {
    const list = this.bars.get(bar.symbol) ?? [];
    /*
     * 「轮」的判据是**全局轮钟**（roundTs），不是单标的的上一根时间：
     * 同一时间戳的多根 K 线（各标的）都属于同一轮。若按「本标的上一根」
     * 判断，两个标的交替到达时每根都是新轮，「轮」永远凑不满，
     * complete 分支永不触发（曾经因此决策死锁在预热期）。
     */
    const isNewRound = this.roundTs === undefined || bar.timestamp.getTime() > this.roundTs.getTime();

    /*
     * 新一轮的第一根：上一轮已在它的最后一根凑齐并结过账（complete 分支），
     * 这里只做「换轮」：重置 round、记下本轮时间戳。当前根必须**先入缓冲**
     * 再进入新轮记账 —— 顺序与数据边界无关（本轮刚开始，还没有决策发生）。
     */
    list.push(bar);
    if (list.length > BUFFER) list.shift();
    this.bars.set(bar.symbol, list);
    this.barsSeen += 1;

    if (isNewRound) {
      // 上一轮已在轮尾凑齐结账 —— 它的标的集合就是「本轮凑齐」的定义。
      // 没有这颗种子，complete 分支的 expected.size>0 永远不成立，决策死锁。
      if (this.round.size > 0) this.expected = new Set(this.round);
      this.round = new Set([bar.symbol]);
      this.roundTs = bar.timestamp;
      return;
    }
    this.round.add(bar.symbol);
    /*
     * 等一轮凑齐再决策（补齐的那根是本轮最后一根）：
     * 1) 数据完整——所有标的的本轮 K 线都已入缓冲。在第一个标的到达就决策，
     *    快照是「先到标的的本轮数据 + 其余标的的上一轮数据」拼出来的；
     * 2) 时序安全——broker 先于 agents 订阅 BAR，本轮每一根开盘时上一轮的
     *    对应订单已撮合完毕。若在本轮中途决策，新单会在其余标的的成交 bar
     *    到达之前就把它「取代」掉——订单永远死在成交前一步，一单都成不了。
     * 信号时间戳打本轮（roundTs）：决策用的数据边界就是本轮收盘，
     * 撮合守卫会把成交推迟到各标的的下一根开盘。
     */
    if (this.expected.size > 0 && this.round.size >= this.expected.size) {
      await this.decide(this.roundTs!, true);
      this.expected = new Set(this.round);
      this.round = new Set();
    }
  }

  /**
   * 一轮行情 = 一次决策机会；按 interval 节流后再真正调用模型。
   *
   * roundsElapsed：本轮「轮次计数」是否自增。complete（本轮凑齐）与
   * flush（下一轮开头的补结）都代表一轮行情的终结，但同一次轮终结只会
   * 走其中一条路——调用方必须如实标记，否则节流计数会把一轮算成两次，
   * 决策时点整体漂移（曾经踩过：计数翻倍后每 5 轮决策实际落在 2.5 轮边界上）。
   */
  private async decide(timestamp: Date, roundsElapsed: boolean): Promise<void> {
    // 预热中：K 线只进缓冲区，不决策 —— 实时机器人的统计只能来自实时行情
    if (this.opts.gate?.()) return;
    // 预热未完成时不计入节流计数，保证预热一结束就能做第一次决策
    if (this.snapshots().length === 0) return;
    const due = roundsElapsed && this.rounds % Math.max(1, this.opts.interval) === 0;
    if (roundsElapsed) this.rounds += 1;
    if (!due) return;
    if (this.busy) {
      log.debug("上一轮决策仍在进行，跳过本轮");
      return;
    }
    const snapshots = this.snapshots();

    this.busy = true;
    try {
      const result = this.opts.perSymbolDecide
        ? await this.decidePerSymbol(snapshots)
        : await this.opts.allocator.allocate(snapshots);
      const allocation: Allocation = {
        timestamp,
        weights: result.weights,
        cashWeight: result.cashWeight,
        confidence: result.confidence,
        reason: result.reason,
        source: result.source,
        notes: result.notes,
      };
      this.bus.publish(Topic.ALLOCATION, allocation);
      this.opts.journal?.({
        source: result.source,
        weights: result.weights,
        cashWeight: result.cashWeight,
        confidence: result.confidence,
        reason: result.reason,
        entryBarIndex: this.barsSeen,
      });
      this.publishSignals(allocation, snapshots);
      log.info(
        "[%s] %s · %s",
        result.source,
        describeAllocation(result.weights, result.cashWeight),
        result.reason,
      );
    } catch (err) {
      log.error("资产配置异常，跳过本轮: %s", (err as Error).message);
    } finally {
      this.busy = false;
    }
  }

  /** 逐标的决策：权重直接给到标的级，无需再走资产配置的额度裁剪。 */
  private async decidePerSymbol(snapshots: AssetSnapshot[]): Promise<AllocationResult> {
    const r = await this.opts.perSymbolDecide!(snapshots);
    const sum = Object.values(r.weights).reduce((a, b) => a + b, 0);
    const clamped: Record<string, number> = {};
    for (const [symbol, w] of Object.entries(r.weights)) {
      const capped = Math.min(w, this.opts.limits.maxPositionWeight);
      if (capped > 0) clamped[symbol] = Number(capped.toFixed(6));
    }
    const total = Object.values(clamped).reduce((a, b) => a + b, 0);
    if (total > this.opts.limits.grossCap) {
      const scale = this.opts.limits.grossCap / total;
      for (const k of Object.keys(clamped)) clamped[k] = Number(((clamped[k] ?? 0) * scale).toFixed(6));
    }
    return {
      weights: clamped,
      cashWeight: Number(Math.max(0, 1 - Math.min(total, this.opts.limits.grossCap)).toFixed(6)),
      confidence: r.confidence,
      reason: r.reason,
      source: "hybrid",
      notes: [],
    };
  }

  /** 拆成逐标的信号：被选中的给目标权重，已持有但落选的给 0（触发清仓）。 */
  private publishSignals(allocation: Allocation, snapshots: AssetSnapshot[]): void {
    const held = this.opts.portfolio.positionsSnapshot().map((p) => p.symbol);
    const symbols = [...new Set([...snapshots.map((s) => s.symbol), ...held])];
    for (const symbol of symbols) {
      const weight = allocation.weights[symbol] ?? 0;
      const signal: Signal = {
        symbol,
        timestamp: allocation.timestamp,
        targetWeight: weight,
        confidence: allocation.confidence,
        reason: `[${allocation.source}] ${allocation.reason}`,
      };
      this.bus.publish(Topic.SIGNAL, signal);
    }
  }

  private snapshots(): AssetSnapshot[] {
    const out: AssetSnapshot[] = [];
    for (const [symbol, bars] of this.bars) {
      if (bars.length < this.opts.warmup) continue;
      const price = bars[bars.length - 1]!.close;
      if (!(price > 0)) continue;
      const fastMa = mean(bars.slice(-this.opts.fastWindow).map((b) => b.close));
      const slowMa = mean(bars.slice(-this.opts.slowWindow).map((b) => b.close));
      const momentum = slowMa === 0 ? 0 : (fastMa - slowMa) / slowMa;
      out.push({
        symbol,
        price,
        momentum: round(momentum, 6),
        retShort: ret(bars, 5),
        retLong: ret(bars, 20),
        trend: momentum > 0.001 ? "up" : momentum < -0.001 ? "down" : "flat",
        bars: bars.length,
        commentary: this.views.get(symbol)?.commentary,
        ohlcv: bars.slice(-120),
      });
    }
    return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }
}

function ret(bars: Bar[], n: number): number {
  if (bars.length <= n) return 0;
  const from = bars[bars.length - 1 - n]!.close;
  const to = bars[bars.length - 1]!.close;
  return from === 0 ? 0 : round((to - from) / from, 6);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round(value: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}