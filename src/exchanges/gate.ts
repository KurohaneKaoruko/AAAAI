/**
 * Gate.io 适配器：现货公共行情 + HMAC-SHA512 签名下单。
 *
 * 文档要点：
 * - 基础地址 https://api.gateio.ws/api/v4
 * - 交易对写法为 BTC_USDT（下划线），与 Binance 的 BTCUSDT 不同，内部会自动转换
 * - K 线 /4/spot/candlesticles?currency_pair=&interval=&limit=，返回新->旧
 *   行内字段顺序：[时间戳(秒), 成交额, 收盘价, 最高价, 最低价, 开盘价, 成交量, 是否收盘]
 * - 签名：请求体字符串（POST，含 nonce 字段）做 HMAC-SHA512，十六进制
 *   请求头 KEY / Timestamp(秒) / SIGN
 */

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

const log = getLogger("exchange:gate");

const GATE_MAIN_BASE = "https://api.gateio.ws/api/v4";
const GATE_TESTNET_BASE = "https://api-testnet.gateapi.io/api/v4";

interface GatePair {
  id: string;
  base: string;
  quote: string;
  trade_status: string;
}

/** Gate 用下划线：BTCUSDT -> BTC_USDT。 */
export function toGatePair(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (s.includes("_")) return s;
  // 已知计价币后缀，按最长匹配切分
  const quotes = ["USDT", "USDC", "BTC", "ETH", "TWD"];
  for (const q of quotes) {
    if (s.endsWith(q) && s.length > q.length) return `${s.slice(0, -q.length)}_${q}`;
  }
  return s;
}

/** 判断 Gate 的 fee_currency 是否为该交易对的计价币（USDT 之于 BTC_USDT）。 */
export function isQuoteFee(feeCurrency: string, symbol: string): boolean {
  const quote = toGatePair(symbol).split("_")[1];
  if (!quote) return false;
  return feeCurrency.trim().toUpperCase() === quote;
}

/** 反向：BTC_USDT -> BTCUSDT。 */
export function fromGatePair(pair: string): string {
  return pair.replace("_", "");
}

/** Gate 周期写法：1m / 5m / 15m / 30m / 1h / 4h / 1d。 */
export class GateAdapter implements ExchangeAdapter {
  readonly meta: AdapterMeta = {
    id: "gate",
    name: "Gate.io 芝麻开门",
    assetClass: "crypto",
    description:
      "Gate.io 现货。公开行情固定走主网真实数据（无需密钥）；下单需 API Key/Secret，测试网只影响交易账户。交易对内部使用 BTC_USDT 写法，会自动转换。",
    requiresKeys: true,
    supportsTrading: true,
    supportsTestnet: true,
    klineIntervals: ["10s", "1m", "5m", "15m", "30m", "1h", "4h", "1d"],
    keyFields: [
      { key: "apiKey", label: "API Key", secret: false, placeholder: "粘贴 Gate.io API Key" },
      { key: "apiSecret", label: "API Secret", secret: true, placeholder: "粘贴 Gate.io API Secret" },
    ],
    defaultSymbols: [
      { symbol: "BTC_USDT", name: "比特币", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 4, qtyPrecision: 6 },
      { symbol: "ETH_USDT", name: "以太坊", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 4, qtyPrecision: 6 },
      { symbol: "SOL_USDT", name: "Solana", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 4, qtyPrecision: 6 },
      { symbol: "BNB_USDT", name: "BNB", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 4, qtyPrecision: 6 },
      { symbol: "XRP_USDT", name: "XRP", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 4, qtyPrecision: 6 },
      { symbol: "DOGE_USDT", name: "Dogecoin", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 4, qtyPrecision: 6 },
      { symbol: "TON_USDT", name: "Toncoin", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 4, qtyPrecision: 6 },
      { symbol: "TRX_USDT", name: "TRON", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 4, qtyPrecision: 6 },
      { symbol: "AR_USDT", name: "Arweave", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 4, qtyPrecision: 6 },
    ],
    notes: [
      "签名：HMAC-SHA512(请求体) 的十六进制值，请求头需带 KEY / Timestamp / SIGN",
      "公开行情固定走主网 api.gateio.ws；测试网只影响下单/账户",
      "测试网 baseUrl 为 api-testnet.gateapi.io；测试网 API Key 需在 Gate 测试网单独申请，主网密钥不通用",
    ],
  };

  private cred: Credential = { apiKey: "", apiSecret: "", testnet: true };

  init(cred: Credential): void {
    this.cred = cred;
  }

  /** 测试网与主网交易域只差 baseUrl；公开行情域固定主网。 */
  /** 公开行情固定主网：测试网只用于签名/账户/下单，K 线必须展示真实市场。 */
  private get marketBaseUrl(): string {
    return GATE_MAIN_BASE;
  }

  /** 签名接口：测试网/主网在这里分开。 */
  private get tradeBaseUrl(): string {
    return this.cred.testnet ? GATE_TESTNET_BASE : GATE_MAIN_BASE;
  }

  private get hasKeys(): boolean {
    return Boolean(this.cred.apiKey && this.cred.apiSecret);
  }

  async testConnection(): Promise<ConnectionTest> {
    const net = this.cred.testnet ? "测试网" : "主网";
    try {
      const started = Date.now();
      const res = await fetch(`${this.marketBaseUrl}/spot/currency_pairs`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { ok: false, message: `主网行情 HTTP ${res.status}` };
      const elapsed = Date.now() - started;
      if (this.hasKeys) {
        const account = await this.signedRequest("GET", "/spot/accounts", "");
        if (account.ok) {
          return { ok: true, message: `连接成功（行情：主网实时；交易：${net}，密钥有效，${elapsed}ms）` };
        }
        return { ok: false, message: `主网行情可达（${elapsed}ms），但${net}交易密钥校验失败: ${account.message}` };
      }
      return { ok: true, message: `连接成功（行情：主网实时；交易：${net}，未配置密钥，仅行情）` };
    } catch (err) {
      return { ok: false, message: `连接失败: ${(err as Error).message}` };
    }
  }

  async searchSymbols(query: string, limit = 20): Promise<SymbolInfo[]> {
    const q = query.trim().toUpperCase();
    const res = await fetch(`${this.marketBaseUrl}/spot/currency_pairs`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Gate 交易对列表 HTTP ${res.status}`);
    const pairs = (await res.json()) as GatePair[];
    return pairs
      .filter((p) => p.trade_status === "tradable")
      .filter((p) => {
        if (!q) return true;
        const flat = fromGatePair(p.id).toUpperCase();
        return flat.includes(q) || p.base.includes(q);
      })
      .slice(0, limit)
      .map<SymbolInfo>((p) => ({
        symbol: fromGatePair(p.id),
        name: `${p.base}/${p.quote}`,
        assetClass: "crypto",
        currency: p.quote,
        lotSize: 1,
        pricePrecision: 4,
        qtyPrecision: 8,
      }));
  }

  async fetchTickers(symbols: string[]): Promise<Ticker[]> {
    const out: Ticker[] = [];
    for (const symbol of symbols) {
      try {
        const res = await fetch(
          `${this.marketBaseUrl}/spot/tickers?currency_pair=${encodeURIComponent(toGatePair(symbol))}`,
          { signal: AbortSignal.timeout(8000) },
        );
        if (!res.ok) continue;
        const data = (await res.json()) as {
          currency_pair?: string;
          last?: string;
          change_percentage?: string;
          base_volume?: string;
        }[];
        const t = data[0];
        if (!t?.last) continue;
        out.push({
          symbol,
          price: Number(t.last),
          changePct: Number(t.change_percentage ?? 0) / 100,
          volume: Number(t.base_volume ?? 0),
          timestamp: Date.now(),
        });
      } catch (err) {
        log.warn("Gate 行情 %s 失败: %s", symbol, (err as Error).message);
      }
    }
    return out;
  }

  async fetchKlines(symbol: string, interval: string, limit: number): Promise<Bar[]> {
    const url = `${this.marketBaseUrl}/spot/candlesticks?currency_pair=${encodeURIComponent(toGatePair(symbol))}&interval=${encodeURIComponent(interval)}&limit=${Math.min(limit, 1000)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Gate K 线 HTTP ${res.status}`);
    const rows = (await res.json()) as (string | number)[][];
    const bars = rows.map((r) => ({
      symbol,
      timestamp: new Date(Number(r[0]) * 1000),
      close: Number(r[2]),
      high: Number(r[3]),
      low: Number(r[4]),
      open: Number(r[5]),
      volume: Number(r[6]),
    }));
    // 接口返回新->旧，统一按时间升序
    bars.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return bars;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    if (!this.hasKeys) {
      return {
        orderId: "",
        status: "rejected",
        filledQty: 0,
        avgPrice: 0,
        fee: 0,
        message: "未配置 API Key，无法真实下单",
      };
    }
    // Gate 市价单：amount = 卖出时为基础币数量；买入时若给了金额（quoteQty）
    // 则按金额下单（Gate 语义：市价买 amount=计价币金额），否则退回数量。
    // 只认数量的话，Broker 传来的金额会被当成"数量 0.00003 个币"这种碎片单，
    // 精度校验直接拒单 —— 买不起最小挂单单位。
    const quote = Number(req.quoteQty ?? 0);
    const useQuote = req.type === "MARKET" && req.side === "BUY" && quote > 0;
    const amount = String(useQuote ? quote : (req.quantity ?? 0));
    if (!(Number(amount) > 0)) {
      return {
        orderId: "",
        status: "rejected",
        filledQty: 0,
        avgPrice: 0,
        fee: 0,
        message: useQuote ? "下单金额必须大于 0" : "下单数量必须大于 0",
      };
    }
    const body = [
      "currency_pair=" + encodeURIComponent(toGatePair(req.symbol)),
      "type=" + (req.type === "LIMIT" ? "limit" : "market"),
      "side=" + req.side.toLowerCase(),
      "amount=" + amount,
      ...(req.type === "LIMIT" && req.price
        ? ["price=" + String(req.price), "time_in_force=gtc"]
        : ["time_in_force=ioc"]),
      "nonce=" + String(Date.now() * 1000 + Math.floor(Math.random() * 1000)),
    ].join("&");

    const result = await this.signedRequest("POST", "/spot/orders", body);
    if (!result.ok) {
      return {
        orderId: "",
        status: "rejected",
        filledQty: 0,
        avgPrice: 0,
        fee: 0,
        message: result.message,
      };
    }
    const data = result.data as {
      id?: string;
      left?: string;
      amount?: string;
      average?: string;
      fee?: string;
      fee_currency?: string;
    };
    // 成交量：IOC 市价单可能部分成交。amount 是下单量，left 是剩余量；
    // 市价买按金额下单时 amount 是计价币金额，响应里没有"成交了多少基础币"，
    // 用成交额 / 均价反推（均价缺失时按拒单处理，不猜）。
    const avg = Number(data.average ?? 0);
    const ordered = Number(useQuote ? req.quantity ?? 0 : amount);
    const filled = Math.max(ordered - Number(data.left ?? 0), 0);
    const filledQty = useQuote && avg > 0 ? filled / avg : filled;
    return {
      orderId: data.id ?? "",
      status: filledQty > 0 ? "filled" : "rejected",
      filledQty: filledQty > 0 ? filledQty : 0,
      avgPrice: avg,
      // fee 字段已含币种（fee_currency）：计价币计费时是"金额"（直接用），
      // 基础币计费时是"数量"（乘均价折算成计价金额）。
      // 币种未知时退回旧行为（乘均价），不猜币种。
      fee:
        avg > 0 && data.fee !== undefined && data.fee_currency
          ? isQuoteFee(data.fee_currency, req.symbol)
            ? Number(data.fee)
            : Number(data.fee) * avg
          : Number(data.fee ?? 0) * (avg || 0),
      message: filledQty > 0 ? undefined : "未成交（余额/精度不足或价格已变动）",
    };
  }

  /** Gate 签名请求：签名内容为请求体原文。 */
  private async signedRequest(
    method: "GET" | "POST",
    path: string,
    body: string,
  ): Promise<{ ok: boolean; message: string; data?: unknown }> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signPayload = method === "POST" ? body : "";
    const signature = createHmac("sha512", this.cred.apiSecret)
      .update(signPayload)
      .digest("hex");
    const headers: Record<string, string> = {
      KEY: this.cred.apiKey,
      Timestamp: timestamp,
      SIGN: signature,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    };
    try {
      const res = await fetch(`${this.tradeBaseUrl}${path}`, {
        method,
        headers,
        body: method === "POST" ? body : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      const data = text ? (JSON.parse(text) as unknown) : {};
      if (!res.ok) {
        const label = (data as { label?: string }).label ?? "";
        const message = (data as { message?: string }).message ?? text.slice(0, 200);
        return { ok: false, message: `HTTP ${res.status} ${label} ${message}`.trim() };
      }
      log.debug("Gate %s %s ok", method, path);
      return { ok: true, message: "ok", data };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}