/** 自选标的列表：持久化到 data/watchlist.json。 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AssetClass } from "./exchanges/types.js";
import { getLogger } from "./core/logger.js";

const log = getLogger("watchlist");

export interface WatchItem {
  id: string;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  currency: string;
  /** 行情来源连接 ID */
  connectionId: string;
  addedAt: string;
}

export class WatchlistManager {
  private items: WatchItem[] = [];

  constructor(private readonly dataDir: string) {
    this.load();
  }

  private get path(): string {
    return join(this.dataDir, "watchlist.json");
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      this.items = JSON.parse(readFileSync(this.path, "utf8")) as WatchItem[];
    } catch (err) {
      log.warn("watchlist.json 解析失败: %s", (err as Error).message);
      this.items = [];
    }
  }

  private persist(): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.items, null, 2));
  }

  list(): WatchItem[] {
    return [...this.items];
  }

  has(connectionId: string, symbol: string): boolean {
    return this.items.some((i) => i.connectionId === connectionId && i.symbol === symbol);
  }

  add(item: Omit<WatchItem, "id" | "addedAt">): WatchItem {
    if (this.has(item.connectionId, item.symbol)) {
      throw new Error(`${item.symbol} 已在自选列表中`);
    }
    const created: WatchItem = {
      ...item,
      id: randomUUID().slice(0, 8),
      addedAt: new Date().toISOString(),
    };
    this.items.push(created);
    this.persist();
    return created;
  }

  remove(id: string): void {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length !== before) this.persist();
  }

  clear(): void {
    this.items = [];
    this.persist();
  }
}
