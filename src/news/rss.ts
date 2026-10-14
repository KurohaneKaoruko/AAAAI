/**
 * RSS / Atom 解析：极简、不引依赖。
 *
 * 只取我们需要的三样：标题、摘要/描述、发布时间、链接。
 * 解析结果一律过 sanitize —— 外部内容是不可信输入。
 */

import { getLogger } from "../core/logger.js";
import { sanitize } from "./sentiment.js";
import type { RawNews } from "./types.js";

const log = getLogger("news:rss");

export interface ParsedFeed {
  items: RawNews[];
}

interface Entry {
  title: string;
  summary: string;
  link: string;
  published: string;
}

/** 抓取并解析一个订阅地址。 */
export async function fetchFeed(
  url: string,
  options: { symbol: string; source: string; timeoutMs?: number; limit?: number },
): Promise<RawNews[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "AAAAI/0.1 (+trading-agent)", Accept: "application/rss+xml, application/xml, text/xml, */*" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 2_000_000) throw new Error("响应过大（>2MB）");
    return parseFeed(text, options.symbol, options.source, options.limit ?? 20);
  } finally {
    clearTimeout(timer);
  }
}

/** 解析 RSS 2.0 与 Atom（两者的差异仅在标签名）。 */
export function parseFeed(
  xml: string,
  symbol: string,
  source: string,
  limit = 20,
): RawNews[] {
  const entries = [
    ...matchAll(xml, /<item\b[^>]*>([\s\S]*?)<\/item>/gi),
    ...matchAll(xml, /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
  ];
  const items: RawNews[] = [];
  for (const [, body] of entries.slice(0, limit)) {
    const entry: Entry = {
      title: sanitize(tag(body, "title") ?? "", 160),
      summary: sanitize(tag(body, "description") ?? tag(body, "summary") ?? tag(body, "content") ?? "", 240),
      link: sanitize(extractLink(body) ?? "", 300),
      published: parseDate(tag(body, "pubDate") ?? tag(body, "published") ?? tag(body, "updated") ?? ""),
    };
    if (!entry.title) continue;
    items.push({ symbol, title: entry.title, summary: entry.summary, url: entry.link, source, publishedAt: entry.published });
  }
  if (items.length === 0) log.debug("%s 未解析到条目（%s）", source, xml.slice(0, 80));
  return items;
}

function* matchAll(text: string, re: RegExp): Generator<[string, string]> {
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) yield [m[0], m[1] ?? ""];
}

function tag(body: string, name: string): string | undefined {
  const m = body.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : undefined;
}

/** Atom 的链接在 <link href="...">，RSS 在文本里。 */
function extractLink(body: string): string | undefined {
  const href = body.match(/<link\b[^>]*href=["']([^"']+)["']/i);
  if (href) return href[1];
  const text = tag(body, "link");
  return text?.trim() || undefined;
}

/** 尽量解析多种时间格式；解析失败时退回当前时间（并会在时效过滤里被淘汰）。 */
function parseDate(raw: string): string {
  const s = sanitize(raw, 60);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  const compact = s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const d2 = new Date(compact);
  return Number.isNaN(d2.getTime()) ? new Date().toISOString() : d2.toISOString();
}