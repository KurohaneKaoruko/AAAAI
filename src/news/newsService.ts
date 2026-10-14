/**
 * 新闻服务：抓取 → 清洗 → 去重 → 打分 → 缓存。
 *
 * 设计要点：
 * - 永远不抛异常打断交易：任何源失败都只记录原因，决策链路照常跑；
 * - 有 TTL 缓存与去重（URL/标题哈希），避免反复打扰新闻源、避免重复条目；
 * - 新闻只作参考，不直接产生订单。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getLogger } from "../core/logger.js";
import { fetchFeed } from "./rss.js";
import { label, sanitize, scoreSentiment } from "./sentiment.js";
import type { NewsFetchResult, NewsItem, RawNews } from "./types.js";
import type { NewsSection } from "../configSchema.js";

const log = getLogger("news");

const MAX_ITEMS = 300;

export class NewsService {
  private items: NewsItem[] = [];
  private lastFetchAt = 0;
  private lastErrors: { provider: string; message: string }[] = [];
  private inflight: Promise<NewsFetchResult> | null = null;

  constructor(
    private readonly dataDir: string,
    private config: NewsSection,
  ) {
    this.load();
  }

  useConfig(config: NewsSection): void {
    this.config = config;
  }

  private get path(): string {
    return join(this.dataDir, "news.json");
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      this.items = JSON.parse(readFileSync(this.path, "utf8")) as NewsItem[];
    } catch {
      this.items = [];
    }
  }

  private persist(): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.items.slice(-MAX_ITEMS), null, 2), { mode: 0o600 });
  }

  /** 当前可用新闻（已按时效过滤）。 */
  list(limit = 60): NewsItem[] {
    if (!this.config.enabled) return [];
    const cutoff = Date.now() - this.config.maxAgeHours * 3600_000;
    return this.items
      .filter((i) => new Date(i.publishedAt).getTime() >= cutoff)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, limit);
  }

  /** 供决策链路使用：取某个标的集合的新闻（带缓存，避免每根 K 线都去抓）。 */
  async forSymbols(symbols: string[], force = false): Promise<NewsItem[]> {
    if (!this.config.enabled || symbols.length === 0) return [];
    if (force || Date.now() - this.lastFetchAt >= this.config.refreshMs) {
      await this.refresh(symbols);
    }
    const wanted = new Set(symbols);
    return this.list(this.config.maxPerSymbol * Math.max(1, symbols.length)).filter((i) => wanted.has(i.symbol));
  }

  /** 抓取一轮；并发调用会合并成一次请求。 */
  async refresh(symbols: string[] = []): Promise<NewsFetchResult> {
    if (!this.config.enabled) {
      return { items: [], errors: [], fetchedAt: new Date().toISOString() };
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh(symbols).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(symbols: string[]): Promise<NewsFetchResult> {
    const targets = symbols.length > 0 ? symbols : this.rememberedSymbols();
    const errors: { provider: string; message: string }[] = [];
    const fresh: RawNews[] = [];

    for (const provider of this.config.providers) {
      try {
        for (const symbol of targets.length > 0 ? targets : [""]) {
          const perSymbolUrl = fillTemplate(provider.url, [symbol]);
          if (!perSymbolUrl) continue;
          fresh.push(
            ...(await fetchFeed(perSymbolUrl, {
              symbol,
              source: provider.label,
              timeoutMs: 8000,
              limit: this.config.maxPerSymbol * 3,
            })),
          );
        }
      } catch (err) {
        const message = (err as Error).message;
        errors.push({ provider: provider.label, message });
        log.warn("新闻源「%s」抓取失败: %s", provider.label, message);
      }
    }

    const cutoff = Date.now() - this.config.maxAgeHours * 3600_000;
    const seen = new Set(this.items.map((i) => i.id));
    let added = 0;
    for (const raw of fresh) {
      const item = toItem(raw);
      if (new Date(item.publishedAt).getTime() < cutoff) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      this.items.push(item);
      added += 1;
    }
    if (this.items.length > MAX_ITEMS) this.items = this.items.slice(-MAX_ITEMS);
    this.lastFetchAt = Date.now();
    this.lastErrors = errors;
    if (added > 0) this.persist();
    log.info("新闻：新增 %d 条（共 %d 条，%d 个源失败）", added, this.items.length, errors.length);

    return { items: this.list(), errors, fetchedAt: new Date().toISOString() };
  }

  /** 没传标的时，用最近抓到的标的兜底（模板里带 {symbol} 时至少能试一次）。 */
  private rememberedSymbols(): string[] {
    return [...new Set(this.items.map((i) => i.symbol).filter((s) => s.length > 0))].slice(0, 5);
  }

  status(): {
    enabled: boolean;
    providers: number;
    items: number;
    lastFetchAt: string | null;
    errors: { provider: string; message: string }[];
  } {
    return {
      enabled: this.config.enabled,
      providers: this.config.providers.length,
      items: this.list(1000).length,
      lastFetchAt: this.lastFetchAt > 0 ? new Date(this.lastFetchAt).toISOString() : null,
      errors: this.lastErrors,
    };
  }
}

function toItem(raw: RawNews): NewsItem {
  const title = sanitize(raw.title, 160);
  const summary = sanitize(raw.summary, 240);
  const { score } = scoreSentiment(`${title}。${summary}`);
  return {
    id: hash(raw.url || title),
    symbol: raw.symbol,
    title,
    summary,
    url: sanitize(raw.url, 300),
    source: sanitize(raw.source, 40),
    publishedAt: raw.publishedAt,
    sentiment: score,
    sentimentLabel: label(score),
    fetchedAt: new Date().toISOString(),
  };
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** 替换模板里的 {symbol} / {query}；没有任何占位符时原样返回。 */
function fillTemplate(template: string, symbols: string[]): string {
  if (!template.includes("{symbol}") && !template.includes("{query}")) return template;
  const first = symbols[0];
  if (!first) return "";
  return template.replace(/\{symbol\}/g, encodeURIComponent(first)).replace(/\{query\}/g, encodeURIComponent(first));
}