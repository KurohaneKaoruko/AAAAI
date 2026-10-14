/**
 * 东方财富适配器：A 股 / 港股 / ETF 实时行情（公共接口，无需密钥，仅行情不可下单）。
 * 数据源: push2 / push2his / searchapi.eastmoney.com
 */

import type { Bar } from "../core/types.js";
import type {
  AdapterMeta,
  ConnectionTest,
  Credential,
  ExchangeAdapter,
  OrderRequest,
  OrderResult,
  SymbolInfo,
  Ticker,
} from "./types.js";

interface SuggestItem {
  Code: string;
  Name: string;
  SecurityTypeName?: string;
  MktNum?: string;
  QuoteID?: string;
}

/** 由代码推断 secid（市场.代码）。 */
export function secidOf(symbol: string): string {
  if (symbol.includes(".")) return symbol;
  if (/^(6|9)\d{5}$/.test(symbol)) return `1.${symbol}`; // 上交所
  if (/^(4|8)\d{5}$/.test(symbol)) return `0.${symbol}`; // 北交所（东财市场码 0）
  if (/^(5|1)\d{5}$/.test(symbol)) return `1.${symbol}`; // 上交所基金/转债
  if (/^\d{5}$/.test(symbol)) return `116.${symbol}`; // 港股 5 位
  return `0.${symbol}`; // 深交所默认
}

interface QuoteRow {
  f12: string;
  f14: string;
  f2: number;
  f3: number;
  f5: number;
  f6: number;
}

export class EastmoneyAdapter implements ExchangeAdapter {
  readonly meta: AdapterMeta = {
    id: "eastmoney",
    name: "东方财富（A股/港股）",
    assetClass: "stock",
    description: "A 股、港股、ETF 实时行情与日/分钟 K 线，公共接口无需密钥。仅行情，不可真实下单（可用模拟盘）。",
    requiresKeys: false,
    supportsTrading: false,
    supportsTestnet: false,
    klineIntervals: ["5m", "15m", "30m", "60m", "1d"],
    keyFields: [],
    notes: ["标的代码如 600519 / 000001 / 00700", "交易时段 9:30-15:00 之外价格为收盘价"],
  };

  init(_cred: Credential): void {
    /* 公共接口无需初始化 */
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const res = await fetch(
        "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.600519&fields=f12,f14,f2",
        { signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
      return { ok: true, message: "连接成功（实时行情可达）" };
    } catch (err) {
      return { ok: false, message: `连接失败: ${(err as Error).message}（可能需要外网）` };
    }
  }

  async searchSymbols(query: string, limit = 20): Promise<SymbolInfo[]> {
    const q = query.trim();
    if (!q) return [];
    const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`东财搜索 HTTP ${res.status}`);
    const data = (await res.json()) as { QuotationCodeTable?: { Data?: SuggestItem[] } };
    return (data.QuotationCodeTable?.Data ?? []).map((item) => ({
      symbol: item.Code,
      name: item.Name,
      assetClass: "stock" as const,
      currency: item.MktNum === "116" || /^9/.test(item.Code) ? "HKD" : "CNY",
      lotSize: 100,
      pricePrecision: 2,
      qtyPrecision: 0,
    }));
  }

  async fetchTickers(symbols: string[]): Promise<Ticker[]> {
    if (symbols.length === 0) return [];
    const secids = symbols.map(secidOf).join(",");
    const fields = "f12,f13,f14,f2,f3,f5,f6";
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${encodeURIComponent(secids)}&fields=${fields}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`东财行情 HTTP ${res.status}`);
    const data = (await res.json()) as {
      data?: { diff?: QuoteRow[] | Record<string, QuoteRow> };
    };
    const diff = data.data?.diff;
    const rows: QuoteRow[] = Array.isArray(diff) ? diff : Object.values(diff ?? {});
    return rows
      .map((d) => ({
        symbol: d?.f12 ?? "",
        price: Number(d?.f2 ?? 0),
        changePct: Number(d?.f3 ?? 0) / 100,
        volume: Number(d?.f5 ?? 0),
        timestamp: Date.now(),
      }))
      .filter((t) => t.symbol !== "" && Number.isFinite(t.price));
  }

  async fetchKlines(symbol: string, interval: string, limit: number): Promise<Bar[]> {
    const klt = interval === "1d" ? "101" : interval.replace("m", "").replace("h", "");
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secidOf(symbol))}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=${klt}&fqt=1&end=20500101&lmt=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`东财 K 线 HTTP ${res.status}`);
    const data = (await res.json()) as { data?: { klines?: string[] } };
    return (data.data?.klines ?? []).map((line) => {
      // 时间,开盘,收盘,最高,最低,成交量,成交额
      const [time, open, close, high, low, volume] = line.split(",");
      return {
        symbol,
        timestamp: parseEmTime(String(time), interval),
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        volume: Number(volume),
      };
    });
  }
}

/** 东财时间串 -> Date（日线为 YYYY-MM-DD，分钟线为 YYYY-MM-DD HH:mm）。 */
export function parseEmTime(time: string, interval: string): Date {
  if (interval === "1d") return new Date(`${time}T15:00:00+08:00`);
  return new Date(`${time}:00+08:00`);
}

export type { OrderRequest, OrderResult };
