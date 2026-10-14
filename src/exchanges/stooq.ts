/**
 * Stooq 适配器：美股 / 国际股票日线（公共 CSV，无需密钥，仅行情）。
 * 代码规则: aapl.us / msft.us，详见 https://stooq.com
 */

import type { Bar } from "../core/types.js";
import type {
  AdapterMeta,
  ConnectionTest,
  Credential,
  ExchangeAdapter,
  SymbolInfo,
  Ticker,
} from "./types.js";

/** "AAPL" -> "aapl.us"；已带后缀的原样返回。 */
export function toStooqSymbol(symbol: string): string {
  const s = symbol.trim().toLowerCase();
  if (s.includes(".")) return s;
  return `${s}.us`;
}

/** "aapl.us" -> "AAPL" */
export function fromStooqSymbol(symbol: string): string {
  return symbol.replace(/\.us$/i, "").toUpperCase();
}

export class StooqAdapter implements ExchangeAdapter {
  readonly meta: AdapterMeta = {
    id: "stooq",
    name: "Stooq（美股）",
    assetClass: "stock",
    description: "美股及国际股票日线行情，公共 CSV 无需密钥。仅行情，不可真实下单（可用模拟盘）。",
    requiresKeys: false,
    supportsTrading: false,
    supportsTestnet: false,
    klineIntervals: ["1d"],
    keyFields: [],
    defaultSymbols: [
      { symbol: "AAPL", name: "苹果", assetClass: "stock", currency: "USD", lotSize: 1, pricePrecision: 2, qtyPrecision: 0 },
      { symbol: "MSFT", name: "微软", assetClass: "stock", currency: "USD", lotSize: 1, pricePrecision: 2, qtyPrecision: 0 },
      { symbol: "NVDA", name: "英伟达", assetClass: "stock", currency: "USD", lotSize: 1, pricePrecision: 2, qtyPrecision: 0 },
      { symbol: "TSLA", name: "特斯拉", assetClass: "stock", currency: "USD", lotSize: 1, pricePrecision: 2, qtyPrecision: 0 },
      { symbol: "AMZN", name: "亚马逊", assetClass: "stock", currency: "USD", lotSize: 1, pricePrecision: 2, qtyPrecision: 0 },
      { symbol: "GOOGL", name: "谷歌", assetClass: "stock", currency: "USD", lotSize: 1, pricePrecision: 2, qtyPrecision: 0 },
      { symbol: "META", name: "Meta", assetClass: "stock", currency: "USD", lotSize: 1, pricePrecision: 2, qtyPrecision: 0 },
      { symbol: "SPY", name: "标普500 ETF", assetClass: "stock", currency: "USD", lotSize: 1, pricePrecision: 2, qtyPrecision: 0 },
      { symbol: "QQQ", name: "纳指100 ETF", assetClass: "stock", currency: "USD", lotSize: 1, pricePrecision: 2, qtyPrecision: 0 },
      { symbol: "BRK.B", name: "伯克希尔", assetClass: "stock", currency: "USD", lotSize: 1, pricePrecision: 2, qtyPrecision: 0 },
    ],
    notes: ["代码如 AAPL / MSFT / TSLA（自动补 .us 后缀）", "仅日线，日内策略请使用加密货币或模拟交易所"],
  };

  init(_cred: Credential): void {
    /* 公共接口无需初始化 */
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const res = await fetch("https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=csv", {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
      return { ok: true, message: "连接成功（美股行情可达）" };
    } catch (err) {
      return { ok: false, message: `连接失败: ${(err as Error).message}（可能需要外网）` };
    }
  }

  async searchSymbols(query: string, limit = 20): Promise<SymbolInfo[]> {
    // Stooq 无官方搜索接口；用报价接口探测单个代码是否存在
    const q = query.trim().toUpperCase().replace(/\.US$/, "");
    if (!q) return [];
    const stooq = toStooqSymbol(q);
    const res = await fetch(
      `https://stooq.com/q/l/?s=${encodeURIComponent(stooq)}&f=sd2t2ohlcv&h&e=csv`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) throw new Error(`Stooq HTTP ${res.status}`);
    const text = await res.text();
    const line = text.split("\n")[1]?.trim();
    if (!line || line.startsWith(q, 0) === false) return [];
    return [
      {
        symbol: q,
        name: q,
        assetClass: "stock",
        currency: "USD",
        lotSize: 1,
        pricePrecision: 2,
        qtyPrecision: 0,
      },
    ];
  }

  async fetchTickers(symbols: string[]): Promise<Ticker[]> {
    if (symbols.length === 0) return [];
    const list = symbols.map(toStooqSymbol).join(",");
    const res = await fetch(`https://stooq.com/q/l/?s=${encodeURIComponent(list)}&f=sd2t2ohlcv&h&e=csv`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Stooq 行情 HTTP ${res.status}`);
    const text = await res.text();
    const lines = text.split("\n").slice(1).filter((l) => l.trim().length > 0);
    return lines
      .map((line) => {
        const cols = line.split(",");
        const symbol = fromStooqSymbol(cols[0] ?? "");
        const date = cols[1] ?? "";
        const time = cols[2] ?? "";
        const open = Number(cols[3]);
        const high = Number(cols[4]);
        const low = Number(cols[5]);
        const close = Number(cols[6]);
        const volume = Number(cols[7]);
        const changePct = open > 0 ? (close - open) / open : 0;
        return { symbol, price: close, changePct, volume, timestamp: Date.parse(`${date}T${time}Z`) || Date.now() };
      })
      .filter((t) => Number.isFinite(t.price) && t.price > 0)
      .slice(0, limit(symbols.length));
  }

  async fetchKlines(symbol: string, interval: string, limit: number): Promise<Bar[]> {
    if (interval !== "1d") {
      throw new Error("Stooq 仅支持日线（1d）");
    }
    const stooq = toStooqSymbol(symbol);
    const res = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(stooq)}&i=d`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Stooq 日线 HTTP ${res.status}`);
    const text = await res.text();
    const lines = text.split("\n").slice(1);
    const rows = lines
      .map((line) => {
        const cols = line.trim().split(",");
        if (cols.length < 5) return null;
        const date = cols[0]!;
        return {
          symbol,
          timestamp: new Date(`${date}T14:30:00Z`), // 美股收盘时间近似
          open: Number(cols[1]),
          high: Number(cols[2]),
          low: Number(cols[3]),
          close: Number(cols[4]),
          volume: Number(cols[5] ?? 0),
        };
      })
      .filter((r): r is Bar => r !== null && Number.isFinite(r.close))
      .slice(-limit);
    return rows;
  }
}

function limit(n: number): number {
  return n;
}
