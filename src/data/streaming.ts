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

/** 推进模式：逐根广播 K 线。 */
export async function streamBars(bus: EventBus, book: PriceBook, bars: Bar[]): Promise<void> {
  for (const bar of bars) {
    book.update(bar);
    await bus.publishAsync(Topic.BAR, bar);
  }
}

export interface LivePollerOptions {
  symbols: string[];
  interval: string;
  pollMs: number;
}

/**
 * 实时轮询器：周期性拉取各标的最新 2 根 K 线，
 * 只广播上次之后的新 K 线（未收盘的最后一根会随每次轮询更新）。
 */
export class LivePoller {
  private timer: NodeJS.Timeout | null = null;
  private lastBarTime = 0;
  private busy = false;

  constructor(
    private readonly adapter: ExchangeAdapter,
    private readonly bus: EventBus,
    private readonly book: PriceBook,
    private readonly opts: LivePollerOptions,
  ) {}

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
      const fresh = groups
        .flat()
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
