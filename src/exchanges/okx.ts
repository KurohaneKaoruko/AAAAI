/** OKX 适配器：公共行情 + OK-ACCESS 签名下单。 */

import { createHmac } from "node:crypto";
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
import { getLogger } from "../core/logger.js";

const log = getLogger("exchange:okx");

interface OkxInstrument {
  instId: string;
  baseCcy: string;
  quoteCcy: string;
  state: string;
}

export class OkxAdapter implements ExchangeAdapter {
  readonly meta: AdapterMeta = {
    id: "okx",
    name: "OKX",
    assetClass: "crypto",
    description: "OKX 统一账户。行情公共可用；下单需 API Key + Secret + Passphrase（Passphrase 填到 Secret 同一栏，用英文冒号连接）。",
    requiresKeys: true,
    supportsTrading: true,
    supportsTestnet: true,
    klineIntervals: ["1m", "5m", "15m", "1h", "4h", "1d"],
    keyFields: [
      { key: "apiKey", label: "API Key", secret: false, placeholder: "粘贴 OKX API Key" },
      { key: "apiSecret", label: "Secret（或 Secret:Passphrase）", secret: true, placeholder: "Secret:Passphrase" },
    ],
    notes: ["签名: base64(HMAC-SHA256(ts+method+path+body))", "x-simulated-trading=1 走模拟盘"],
  };

  private cred: Credential = { apiKey: "", apiSecret: "", testnet: true };

  init(cred: Credential): void {
    this.cred = cred;
  }

  private get baseUrl(): string {
    return "https://www.okx.com";
  }

  /** "secret" 或 "secret:passphrase"。 */
  private get passphrase(): string {
    const idx = this.cred.apiSecret.indexOf(":");
    return idx >= 0 ? this.cred.apiSecret.slice(idx + 1) : "";
  }

  private get secret(): string {
    const idx = this.cred.apiSecret.indexOf(":");
    return idx >= 0 ? this.cred.apiSecret.slice(0, idx) : this.cred.apiSecret;
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v5/public/time`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
      if (this.cred.apiKey) {
        const body = JSON.stringify({ instType: "SPOT" });
        const result = await this.signedRequest("GET", "/api/v5/trade/order?instType=SPOT&limit=1", "");
        void body;
        if (result.ok) return { ok: true, message: "连接成功（密钥有效）" };
        return { ok: false, message: `行情可达，密钥校验失败: ${result.message}` };
      }
      return { ok: true, message: "连接成功（未配置密钥，仅行情）" };
    } catch (err) {
      return { ok: false, message: `连接失败: ${(err as Error).message}` };
    }
  }

  async searchSymbols(query: string, limit = 20): Promise<SymbolInfo[]> {
    const q = query.trim().toUpperCase();
    const url = `${this.baseUrl}/api/v5/public/instruments?instType=SPOT`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`OKX instruments HTTP ${res.status}`);
    const data = (await res.json()) as { data?: OkxInstrument[] };
    return (data.data ?? [])
      .filter((i) => i.state === "live" && (!q || i.instId.toUpperCase().includes(q)))
      .slice(0, limit)
      .map<SymbolInfo>((i) => ({
        symbol: i.instId,
        name: `${i.baseCcy}/${i.quoteCcy}`,
        assetClass: "crypto",
        currency: i.quoteCcy,
        lotSize: 1,
        pricePrecision: 4,
        qtyPrecision: 6,
      }));
  }

  async fetchTickers(symbols: string[]): Promise<Ticker[]> {
    const out: Ticker[] = [];
    for (const instId of symbols) {
      const res = await fetch(`${this.baseUrl}/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        data?: { last: string; open24h: string; vol24h: string; ts: string }[];
      };
      const t = data.data?.[0];
      if (!t) continue;
      const last = Number(t.last);
      const open24h = Number(t.open24h);
      out.push({
        symbol: instId,
        price: last,
        changePct: open24h > 0 ? (last - open24h) / open24h : 0,
        volume: Number(t.vol24h),
        timestamp: Number(t.ts),
      });
    }
    return out;
  }

  async fetchKlines(symbol: string, interval: string, limit: number): Promise<Bar[]> {
    // OKX 的 candlesticks 只返回"历史"（已收盘）K 线，且新->旧
    const url = `${this.baseUrl}/api/v5/market/history-candles?instId=${encodeURIComponent(symbol)}&bar=${encodeURIComponent(interval)}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`OKX candles HTTP ${res.status}`);
    const data = (await res.json()) as { data?: string[][] };
    const rows = (data.data ?? []).map((r) => ({
      ts: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
    }));
    rows.sort((a, b) => a.ts - b.ts);
    return rows.map((r) => ({
      symbol,
      timestamp: new Date(r.ts),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    if (!this.cred.apiKey || !this.secret) {
      return { orderId: "", status: "rejected", filledQty: 0, avgPrice: 0, fee: 0, message: "未配置 API Key" };
    }
    const body = JSON.stringify({
      instId: req.symbol,
      tdMode: "cash",
      side: req.side.toLowerCase(),
      ordType: req.type === "LIMIT" ? "limit" : "market",
      sz: String(req.quantity ?? 0),
      ...(req.type === "LIMIT" && req.price ? { px: String(req.price) } : {}),
    });
    const result = await this.signedRequest("POST", "/api/v5/trade/order", body);
    if (!result.ok) {
      return { orderId: "", status: "rejected", filledQty: 0, avgPrice: 0, fee: 0, message: result.message };
    }
    const data = result.data as { data?: { ordId?: string; fillPx?: string; fillSz?: string; sCode?: string; sMsg?: string }[] };
    const first = data.data?.[0];
    if (!first || first.sCode !== "0") {
      return {
        orderId: "",
        status: "rejected",
        filledQty: 0,
        avgPrice: 0,
        fee: 0,
        message: first?.sMsg ?? "下单被拒绝",
      };
    }
    const qty = Number(first.fillSz ?? 0);
    const px = Number(first.fillPx ?? 0);
    return {
      orderId: first.ordId ?? "",
      status: "filled",
      filledQty: qty,
      avgPrice: px,
      fee: qty * px * 0.001,
    };
  }

  /** 带 OK-ACCESS 签名的请求。 */
  private async signedRequest(
    method: "GET" | "POST",
    path: string,
    body: string,
  ): Promise<{ ok: boolean; message: string; data?: unknown }> {
    const ts = new Date().toISOString().slice(0, 19) + "Z";
    const prehash = ts + method + path + body;
    const sign = createHmac("sha256", this.secret, { encoding: "base64" as never })
      .update(prehash)
      .digest("base64");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": this.cred.apiKey,
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": ts,
    };
    if (this.passphrase) headers["OK-ACCESS-PASSPHRASE"] = this.passphrase;
    if (this.cred.testnet) headers["x-simulated-trading"] = "1";
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body || undefined,
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json().catch(() => ({}));
      const code = (data as { code?: string; msg?: string }).code;
      if (!res.ok || (code && code !== "0")) {
        return { ok: false, message: `HTTP ${res.status} ${(data as { msg?: string }).msg ?? ""}`.trim() };
      }
      log.debug("OKX %s %s ok", method, path);
      return { ok: true, message: "ok", data };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}
