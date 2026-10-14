/** 行情服务：拉取 K 线并向总线广播 BAR 事件；维护最新价缓存。 */

import { EventBus, Topic } from "../core/eventBus.js";
import type { Bar } from "../core/types.js";
import { getLogger } from "../core/logger.js";
import type { DataSource } from "./dataSource.js";

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

/** 推进模式的行情服务：调用方给一批 Bar，逐根广播。 */
export async function streamBars(bus: EventBus, book: PriceBook, bars: Bar[]): Promise<void> {
  for (const bar of bars) {
    book.update(bar);
    await bus.publishAsync(Topic.BAR, bar);
  }
}

/** live 模式轮询器：周期性拉取新收盘 K 线并广播。 */
export class LivePoller {
  private timer: NodeJS.Timeout | null = null;
  private lastBarTime = 0;
  private busy = false;

  constructor(
    private readonly source: DataSource,
    private readonly bus: EventBus,
    private readonly book: PriceBook,
    private readonly opts: { symbol: string; interval: string; pollMs: number },
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
      const bars = await this.source.fetchBars({
        symbol: this.opts.symbol,
        limit: 2,
        interval: this.opts.interval,
      });
      const fresh = bars.filter((b) => b.timestamp.getTime() > this.lastBarTime);
      if (fresh.length === 0) return;
      this.lastBarTime = fresh[fresh.length - 1]!.timestamp.getTime();
      onBars(fresh);
    } catch (err) {
      log.warn("轮询行情失败: %s", (err as Error).message);
    } finally {
      this.busy = false;
    }
  }
}
