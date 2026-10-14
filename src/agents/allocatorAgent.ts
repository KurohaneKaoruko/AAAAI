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
}

export class AllocatorAgent extends Agent {
  readonly name = "allocator";

  private readonly bars = new Map<string, Bar[]>();
  private readonly views = new Map<string, MarketView>();
  /** 本轮已收到的 K 线所属标的 */
  private round = new Set<string>();
  /** 上一轮的标的集合，用来判断本轮是否收齐 */
  private expected = new Set<string>();
  private decisions = 0;
  private busy = false;

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
    if (list.length > 0 && bar.timestamp.getTime() > list[list.length - 1]!.timestamp.getTime()) {
      // 新的时间戳 = 上一轮结束。若上一轮没收齐（如实盘轮询缺某个标的），先把已有数据用掉。
      if (this.round.size > 0) await this.decide(list[list.length - 1]!.timestamp);
      this.expected = new Set(this.round);
      this.round = new Set();
    }
    this.round.add(bar.symbol);

    list.push(bar);
    if (list.length > BUFFER) list.shift();
    this.bars.set(bar.symbol, list);

    // 本轮收齐（模拟盘/回测下所有标的同一时间戳）时立刻决策
    if (this.expected.size > 0 && this.round.size >= this.expected.size) {
      await this.decide(bar.timestamp);
    }
  }

  /** 一轮行情 = 一次资产配置。 */
  private async decide(timestamp: Date): Promise<void> {
    if (this.decisions % Math.max(1, this.opts.interval) !== 0) return;
    if (this.busy) {
      log.debug("上一轮配置仍在进行，跳过本轮");
      return;
    }
    const snapshots = this.snapshots();
    if (snapshots.length === 0) return;

    this.busy = true;
    this.decisions += 1;
    try {
      const result = await this.opts.allocator.allocate(snapshots);
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