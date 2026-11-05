/** 行情流工具：最新价缓存、K 线广播、多标的 K 线归并、实时轮询。 */

import { EventBus, Topic } from "../core/eventBus.js";
import type { Bar } from "../core/types.js";
import { getLogger } from "../core/logger.js";
import type { ExchangeAdapter } from "../exchanges/types.js";

const log = getLogger("market");

/** 最新价缓存（风控 / 执行层查询行情用）。 */
export class PriceBook {
  private prices = new Map<string, number>();

  update(bar: Bar): void {
    this.prices.set(bar.symbol, bar.close);
  }

  last(symbol: string): number | undefined {
    return this.prices.get(symbol);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.prices);
  }
}

/** 把多个标的的 K 线按时间归并成全局时间序列（回测用）。 */
export function mergeBarsByTime(groups: Bar[][]): Bar[] {
  const merged: Bar[] = [];
  for (const group of groups) merged.push(...group);
  merged.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.symbol.localeCompare(b.symbol));
  return merged;
}

/** 把 `1m` / `5m` / `1h` / `1d` / `1w` 这类周期换算成毫秒。 */
export function intervalMs(interval: string): number {
  const m = /^(\d+)\s*([smhdw])$/i.exec((interval ?? "1m").trim());
  if (!m) return 60_000;
  const n = Number(m[1]) || 1;
  const unit = m[2]!.toLowerCase();
  const base = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
  return n * base;
}

/**
 * 只保留**已经收盘**的 K 线。
 *
 * 真实交易所的最新一根通常是仍在形成的当前周期；把它当收盘价喂给策略，
 * 会让历史模拟/实时机器人在“这根 K 线还没走完”时提前决策，成交与统计都不真实。
 *
 * 判断依据：K 线 timestamp 是开盘时间；开盘时间 + 周期 <= now 才算收盘。
 * 各适配器（Binance/Gate/OKX/Stooq/模拟所）对外都按这个语义返回 timestamp。
 */
export function closedBars(bars: Bar[], interval: string, now = Date.now()): Bar[] {
  const step = intervalMs(interval);
  return bars.filter((b) => b.timestamp.getTime() + step <= now);
}

/** 推进模式：逐根广播 K 线。 */
/**
 * 把一段 K 线按顺序广播出去（回测 / 预热都用它）。
 *
 * `settle` 钩子在每根派发完之后调用（如等待异步策略沙箱排空）：
 * 同步策略的信号当根就落地，异步策略（自定义代码走 worker 往返）不排空的话
 * 会全部积压到回放结束才产生，订单互相取代、永远等不到下一根 K 线成交。
 */
export async function streamBars(
  bus: EventBus,
  book: PriceBook,
  bars: Bar[],
  settle?: () => Promise<void>,
): Promise<void> {
  for (const bar of bars) {
    book.update(bar);
    await bus.publishAsync(Topic.BAR, bar);
    if (settle) await settle();
  }
}

export interface LivePollerOptions {
  symbols: string[];
  interval: string;
  pollMs: number;
  /**
   * 已经处理到哪一根 K 线（毫秒时间戳）。机器人预热完最后一条已收盘 K 线后
   * 必须把它传进来，否则第一次轮询会把预热里的最后一根再喂一遍。
   */
  sinceMs?: number;
  /**
   * 是否只接受已收盘 K 线。真实行情默认 true；模拟交易所的“当前周期”
   * 本身就是按当前时刻生成的完整合成 K 线，保留旧行为以便测试/演示。
   */
  closedOnly?: boolean;
}

/**
 * 实时轮询器：周期性拉取各标的最新 2 根 K 线，
 * 只广播上次之后的新 K 线（未收盘的最后一根会随每次轮询更新）。
 */
export class LivePoller {
  private timer: NodeJS.Timeout | null = null;
  private lastBarTime: number;
  private busy = false;

  constructor(
    private readonly adapter: ExchangeAdapter,
    private readonly bus: EventBus,
    private readonly book: PriceBook,
    private readonly opts: LivePollerOptions,
  ) {
    this.lastBarTime = opts.sinceMs ?? 0;
  }

  start(onBars: (bars: Bar[]) => void): void {
    void this.tick(onBars);
    this.timer = setInterval(() => void this.tick(onBars), this.opts.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(onBars: (bars: Bar[]) => void): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const groups = await Promise.all(
        this.opts.symbols.map(async (symbol) => {
          try {
            return await this.adapter.fetchKlines(symbol, this.opts.interval, 2);
          } catch (err) {
            log.warn("拉取 %s 行情失败: %s", symbol, (err as Error).message);
            return [] as Bar[];
          }
        }),
      );
      const candidates = this.opts.closedOnly === false ? groups.flat() : closedBars(groups.flat(), this.opts.interval);
      const fresh = candidates
        .filter((b) => b.timestamp.getTime() > this.lastBarTime)
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.symbol.localeCompare(b.symbol));
      if (fresh.length === 0) return;
      this.lastBarTime = fresh[fresh.length - 1]!.timestamp.getTime();
      onBars(fresh);
    } finally {
      this.busy = false;
    }
  }
}
