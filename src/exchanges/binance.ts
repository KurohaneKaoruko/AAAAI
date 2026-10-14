/** Binance 现货适配器：公共行情 + HMAC 签名下单。 */

import { createHmac } from "node:crypto";
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
import { getLogger } from "../core/logger.js";

const log = getLogger("exchange:binance");

interface BinanceSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
}

export class BinanceAdapter implements ExchangeAdapter {
  readonly meta: AdapterMeta = {
    id: "binance",
    name: "Binance 币安",
    assetClass: "crypto",
    description: "币安现货。行情为公共接口无需密钥；下单需 API Key（默认测试网）。",
    requiresKeys: true,
    supportsTrading: true,
    supportsTestnet: true,
    klineIntervals: ["1m", "5m", "15m", "1h", "4h", "1d"],
    keyFields: [
      { key: "apiKey", label: "API Key", secret: false, placeholder: "粘贴 Binance API Key" },
      { key: "apiSecret", label: "API Secret", secret: true, placeholder: "粘贴 API Secret" },
    ],
    notes: ["下单走 HMAC-SHA256 签名", "测试网 baseUrl 为 testnet.binance.vision", "市价买入使用 quoteOrderQty（金额）"],
  };

  private cred: Credential = { apiKey: "", apiSecret: "", testnet: true };

  init(cred: Credential): void {
    this.cred = cred;
  }

  private get baseUrl(): string {
    return this.cred.testnet ? "https://testnet.binance.vision" : "https://api.binance.com";
  }

  private get hasKeys(): boolean {
    return Boolean(this.cred.apiKey && this.cred.apiSecret);
  }

  async testConnection(): Promise<ConnectionTest> {
    const started = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/api/v3/ping`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
      if (this.hasKeys) {
        // Key 有效性：读取账户接口
        const account = await this.signedGet("/api/v3/account");
        if (account.ok) {
          return { ok: true, message: `连接成功（${this.cred.testnet ? "测试网" : "主网"}，密钥有效）` };
        }
        return { ok: false, message: `行情可达，但密钥校验失败: ${account.message}` };
      }
      return { ok: true, message: `连接成功（${this.cred.testnet ? "测试网" : "主网"}，未配置密钥，仅行情）` };
    } catch (err) {
      return { ok: false, message: `连接失败: ${(err as Error).message}（${Date.now() - started}ms）` };
    }
  }

  async searchSymbols(query: string, limit = 20): Promise<SymbolInfo[]> {
    const q = query.trim().toUpperCase();
    const url = `${this.baseUrl}/api/v3/exchangeInfo`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Binance exchangeInfo HTTP ${res.status}`);
    const info = (await res.json()) as { symbols: BinanceSymbol[] };
    const list = info.symbols
      .filter((s) => s.status === "TRADING" && (!q || s.symbol.toUpperCase().includes(q)))
      .slice(0, limit)
      .map<SymbolInfo>((s) => ({
        symbol: s.symbol,
        name: `${s.baseAsset}/${s.quoteAsset}`,
        assetClass: "crypto",
        currency: s.quoteAsset,
        lotSize: 1,
        pricePrecision: 2,
        qtyPrecision: 6,
      }));
    return list;
  }

  async fetchTickers(symbols: string[]): Promise<Ticker[]> {
    if (symbols.length === 0) return [];
    const url = `${this.baseUrl}/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Binance 24hr HTTP ${res.status}`);
    const raw = (await res.json()) as
      | { symbol: string; lastPrice: string; priceChangePercent: string; volume: string }[]
      | { symbol: string; lastPrice: string; priceChangePercent: string; volume: string };
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map((t) => ({
      symbol: t.symbol,
      price: Number(t.lastPrice),
      changePct: Number(t.priceChangePercent) / 100,
      volume: Number(t.volume),
      timestamp: Date.now(),
    }));
  }

  async fetchKlines(symbol: string, interval: string, limit: number): Promise<Bar[]> {
    const url = `${this.baseUrl}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}`);
    const raw = (await res.json()) as [number, string, string, string, string, string, ...unknown[]][];
    return raw.map((k) => ({
      symbol,
      timestamp: new Date(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }));
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    if (!this.hasKeys) {
      return { orderId: "", status: "rejected", filledQty: 0, avgPrice: 0, fee: 0, message: "未配置 API Key，无法真实下单" };
    }
    const params = new URLSearchParams({
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      timestamp: String(Date.now()),
      recvWindow: "5000",
    });
    if (req.type === "LIMIT" && req.price) {
      params.set("timeInForce", "GTC");
      params.set("price", String(req.price));
      params.set("quantity", String(req.quantity ?? 0));
    } else if (req.quantity) {
      params.set("quantity", String(req.quantity));
    } else if (req.quoteQty) {
      params.set("quoteOrderQty", String(req.quoteQty));
    }
    params.set("signature", createHmac("sha256", this.cred.apiSecret).update(params.toString()).digest("hex"));

    const res = await fetch(`${this.baseUrl}/api/v3/order`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-MBX-APIKEY": this.cred.apiKey },
      body: params.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as {
      code?: number;
      msg?: string;
      orderId?: number;
      executedQty?: string;
      cummulativeQuoteQty?: string;
    };
    if (!res.ok || data.code) {
      return {
        orderId: "",
        status: "rejected",
        filledQty: 0,
        avgPrice: 0,
        fee: 0,
        message: `HTTP ${res.status} ${data.msg ?? ""}`.trim(),
      };
    }
    const filledQty = Number(data.executedQty ?? 0);
    const notional = Number(data.cummulativeQuoteQty ?? 0);
    return {
      orderId: String(data.orderId ?? ""),
      status: "filled",
      filledQty,
      avgPrice: filledQty > 0 ? notional / filledQty : 0,
      fee: notional * 0.001,
    };
  }

  private async signedGet(path: string): Promise<{ ok: boolean; message: string }> {
    const params = new URLSearchParams({ timestamp: String(Date.now()), recvWindow: "5000" });
    params.set("signature", createHmac("sha256", this.cred.apiSecret).update(params.toString()).digest("hex"));
    const res = await fetch(`${this.baseUrl}${path}?${params.toString()}`, {
      headers: { "X-MBX-APIKEY": this.cred.apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { msg?: string };
      return { ok: false, message: `HTTP ${res.status} ${data.msg ?? ""}`.trim() };
    }
    log.debug("Binance signed GET %s ok", path);
    return { ok: true, message: "ok" };
  }
}

export type { Side };
