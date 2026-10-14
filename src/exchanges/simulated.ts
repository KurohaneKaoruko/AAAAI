/**
 * 模拟交易所：离线可用、可复现的随机漫步行情 + 模拟成交。
 * 用途：无外网环境演示、CI 测试、策略干跑。
 */

import type { Bar, Side } from "../core/types.js";
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

const DEMO_SYMBOLS: SymbolInfo[] = [
  { symbol: "DEMO-BTC", name: "模拟比特币", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 2, qtyPrecision: 6 },
  { symbol: "DEMO-ETH", name: "模拟以太坊", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 2, qtyPrecision: 6 },
  { symbol: "600519", name: "模拟茅台", assetClass: "stock", currency: "CNY", lotSize: 100, pricePrecision: 2, qtyPrecision: 0 },
  { symbol: "AAPL", name: "模拟苹果", assetClass: "stock", currency: "USD", lotSize: 1, pricePrecision: 2, qtyPrecision: 0 },
];

/** 由 symbol 派生的确定性种子，保证同一代码价格轨迹一致。 */
function seedOf(symbol: string): number {
  let h = 2166136261;
  for (let i = 0; i < symbol.length; i += 1) {
    h ^= symbol.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 解析 K 线周期字符串为毫秒。 */
function intervalMs(interval: string): number {
  const n = parseInt(interval, 10);
  if (Number.isNaN(n)) return 60_000;
  return n * (interval.includes("h") ? 3_600_000 : interval.includes("d") ? 86_400_000 : 60_000);
}

export class SimulatedAdapter implements ExchangeAdapter {
  readonly meta: AdapterMeta = {
    id: "simulated",
    name: "模拟交易所",
    assetClass: "mixed",
    description: "离线随机漫步行情，K 线与成交全部本地生成，可复现。适合演示、测试与策略干跑。",
    requiresKeys: false,
    supportsTrading: true,
    supportsTestnet: false,
    klineIntervals: ["1m", "5m", "15m", "1h", "4h", "1d"],
    keyFields: [],
    notes: ["无需密钥", "价格由代码哈希决定，同一代码轨迹固定"],
  };

  init(_cred: Credential): void {
    /* 无需初始化 */
  }

  async testConnection(): Promise<ConnectionTest> {
    return { ok: true, message: "模拟交易所始终可用（本地生成行情）" };
  }

  async searchSymbols(query: string, limit = 20): Promise<SymbolInfo[]> {
    const q = query.trim().toUpperCase();
    if (!q) return DEMO_SYMBOLS.slice(0, limit);
    return DEMO_SYMBOLS.filter(
      (s) => s.symbol.toUpperCase().includes(q) || s.name.includes(query.trim()),
    ).slice(0, limit);
  }

  /** 当前价（走势的最后一根收盘价）。 */
  private currentPrice(symbol: string): number {
    const rng = makeRng(seedOf(symbol));
    let price = 100;
    const steps = 5000;
    for (let i = 0; i < steps; i += 1) {
      price *= 1 + (rng() - 0.5) * 0.02;
    }
    return price;
  }

  async fetchTickers(symbols: string[]): Promise<Ticker[]> {
    return symbols.map((symbol) => {
      const price = this.currentPrice(symbol);
      // 由同一 RNG 派生的小幅日内涨跌
      const changePct = (makeRng(seedOf(symbol) + 1)() - 0.5) * 0.06;
      return {
        symbol,
        price,
        changePct,
        volume: 1_000_000,
        timestamp: Date.now(),
      };
    });
  }

  async fetchKlines(symbol: string, interval: string, limit: number): Promise<Bar[]> {
    const rng = makeRng(seedOf(symbol));
    const step = intervalMs(interval);
    const bars: Bar[] = [];

    // 先推进到"现在"，再截取最后 limit 根
    const warmup = 5000;
    let price = 100;
    let prev = price;
    for (let i = 0; i < warmup; i += 1) {
      prev = price;
      price *= 1 + (rng() - 0.48) * 0.02;
    }

    const now = Date.now();
    const start = now - limit * step;
    let ts = start;
    let cur = price * 0.92; // 回退一截，让窗口有走势
    for (let i = 0; i < limit; i += 1) {
      const drift = (rng() - 0.48) * 0.02;
      const open = cur;
      cur = Math.max(1, cur * (1 + drift));
      const close = cur;
      const high = Math.max(open, close) * (1 + rng() * 0.004);
      const low = Math.min(open, close) * (1 - rng() * 0.004);
      bars.push({
        symbol,
        timestamp: new Date(ts),
        open: r4(open),
        high: r4(high),
        low: r4(low),
        close: r4(close),
        volume: r2(500_000 + rng() * 500_000),
      });
      ts += step;
    }
    void prev;
    return bars;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const price = this.currentPrice(req.symbol);
    const qty = req.quoteQty && !req.quantity ? req.quoteQty / price : (req.quantity ?? 0);
    if (!(qty > 0)) {
      return { orderId: "", status: "rejected", filledQty: 0, avgPrice: 0, fee: 0, message: "数量必须为正" };
    }
    const notional = qty * price;
    const fee = notional * 0.001;
    return {
      orderId: `SIM-${Date.now()}`,
      status: "filled",
      filledQty: qty,
      avgPrice: price,
      fee,
      message: "模拟成交",
    };
  }
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}
function r4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

export type { Side };
