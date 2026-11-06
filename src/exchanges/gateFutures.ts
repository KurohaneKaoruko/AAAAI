/**
 * Gate.io USDT 永续合约：真实公共行情 + 本地模拟撮合。
 *
 * 为什么先只做行情/模拟盘：
 * - 合约的真实下单涉及保证金模式、逐仓/全仓、资金费、强平引擎与合约张数换算，
 *   任何一项没接好都可能让用户以为在下单、实际下错方向或数量；
 * - 因此本适配器明确 `supportsTrading: false`：机器人用真实合约行情 + 本地保证金
 *   记账做验证，真正下单入口保持关闭。
 *
 * 行情接口（公共，无需密钥）：
 * - 合约列表：/futures/usdt/contracts
 * - 单合约：  /futures/usdt/contracts/BTC_USDT
 * - K 线：    /futures/usdt/candlesticks?contract=BTC_USDT&interval=1m&limit=...
 * - 快照：    /futures/usdt/tickers
 *
 * 测试网：https://api-testnet.gateapi.io/api/v4（与主网路径一致）。
 */

import type { Bar } from "../core/types.js";
import type {
  AdapterMeta,
  ConnectionTest,
  Credential,
  ExchangeAdapter,
  OrderBookSnapshot,
  SymbolInfo,
  Ticker,
} from "./types.js";
import { getLogger } from "../core/logger.js";
import { toGatePair } from "./gate.js";

const log = getLogger("exchange:gate-futures");

const GATE_MAIN_BASE = "https://api.gateio.ws/api/v4";

interface GateContract {
  name: string;
  type?: string;
  in_delisting?: boolean;
  quanto_multiplier?: string;
  order_size_min?: number;
  leverage_max?: string;
  order_price_round?: string;
}

interface GateFuturesTicker {
  contract?: string;
  last?: string;
  change_percentage?: string;
  volume_24h_quote?: string;
  volume_24h_base?: string;
  quanto_multiplier?: string;
}

function decimalsOf(step: string | undefined): number {
  if (!step) return 2;
  const i = step.indexOf(".");
  return i < 0 ? 0 : Math.max(0, step.length - i - 1);
}

/** BTC_USDT -> { base: BTC, quote: USDT }；认不出来时整段当 base。 */
function splitContract(name: string): { base: string; quote: string } {
  const [base, quote] = name.split("_");
  return { base: base || name, quote: quote || "USDT" };
}

/** Gate 合约代码统一为 BTC_USDT；BTCUSDT/BTC-USDT 也能输入。 */
function toContract(symbol: string): string {
  const s = symbol.trim().toUpperCase().replace(/-/g, "_");
  if (s.includes("_")) return s;
  return toGatePair(s);
}

const DEFAULT_SYMBOLS: SymbolInfo[] = [
  { symbol: "BTC_USDT", name: "比特币永续", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 1, qtyPrecision: 8, maxLeverage: 100 },
  { symbol: "ETH_USDT", name: "以太坊永续", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 2, qtyPrecision: 8, maxLeverage: 100 },
  { symbol: "SOL_USDT", name: "Solana 永续", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 3, qtyPrecision: 8, maxLeverage: 100 },
  { symbol: "BNB_USDT", name: "BNB 永续", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 3, qtyPrecision: 8, maxLeverage: 100 },
  { symbol: "XRP_USDT", name: "XRP 永续", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 4, qtyPrecision: 8, maxLeverage: 100 },
  { symbol: "DOGE_USDT", name: "Dogecoin 永续", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 5, qtyPrecision: 8, maxLeverage: 100 },
];

export class GateFuturesAdapter implements ExchangeAdapter {
  readonly meta: AdapterMeta = {
    id: "gate-futures",
    name: "Gate.io 合约（真实行情 / 模拟撮合）",
    assetClass: "crypto",
    description:
      "Gate.io USDT 永续合约主网公共行情。行情真实，下单/撮合在本地模拟，不接真实资金。支持做空与保证金账户；资金费按交易所真实费率每 8 小时结算，不模拟强平与交易所保证金率。",
    requiresKeys: false,
    supportsTrading: false,
    supportsTestnet: false,
    tradingMode: "futures",
    marketData: "real",
    klineIntervals: ["1m", "5m", "15m", "30m", "1h", "4h", "1d"],
    keyFields: [],
    defaultSymbols: DEFAULT_SYMBOLS,
    notes: [
      "公共行情固定走主网真实合约数据；测试网标记只影响连接展示，本适配器不下真实订单",
      "交易对写法：BTC_USDT（也接受 BTCUSDT / BTC-USDT，会自动转换）",
      "K 线为合约标记价格行情；成交量单位以交易所返回为准",
      "资金费按真实费率结算；不模拟维持保证金、逐仓强平与交易所强平引擎",
      "下单/撮合在本地模拟，不会发送真实合约订单",
    ],
  };

  private cred: Credential = { apiKey: "", apiSecret: "", testnet: true };

  init(cred: Credential): void {
    this.cred = cred;
  }

  /**
   * 公开合约行情固定主网。
   *
   * 本适配器不下真实订单，testnet 只是连接标记；K 线必须来自主网真实合约，
   * 否则测试网自成一套价格，画出来不能当实盘行情。
   */
  private get marketBaseUrl(): string {
    return GATE_MAIN_BASE;
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const started = Date.now();
      const res = await fetch(`${this.marketBaseUrl}/futures/usdt/contracts/BTC_USDT`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { ok: false, message: `主网合约行情 HTTP ${res.status}` };
      const c = (await res.json()) as GateContract;
      return {
        ok: true,
        message: `连接成功（主网实时合约行情，${Date.now() - started}ms，合约 ${c.name ?? "BTC_USDT"}；本地模拟撮合）`,
      };
    } catch (err) {
      return { ok: false, message: `合约连接失败: ${(err as Error).message}` };
    }
  }

  async searchSymbols(query: string, limit = 20): Promise<SymbolInfo[]> {
    const q = query.trim().toUpperCase();
    const res = await fetch(`${this.marketBaseUrl}/futures/usdt/contracts`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Gate 合约列表 HTTP ${res.status}`);
    const list = (await res.json()) as GateContract[];
    return list
      .filter((c) => c.name && !c.in_delisting)
      .filter((c) => {
        if (!q) return true;
        const flat = c.name.replace(/_/g, "").toUpperCase();
        const { base } = splitContract(c.name);
        return flat.includes(q.replace(/[-_]/g, "")) || base.includes(q);
      })
      .slice(0, limit)
      .map<SymbolInfo>((c) => {
        const { base, quote } = splitContract(c.name);
        return {
          symbol: c.name,
          name: `${base}/${quote} 永续`,
          assetClass: "crypto",
          currency: quote,
          lotSize: Math.max(1, Number(c.order_size_min ?? 1)),
          pricePrecision: decimalsOf(c.order_price_round),
          qtyPrecision: 8,
          contractSize: Number(c.quanto_multiplier ?? 1) || 1,
          ...(c.leverage_max ? { maxLeverage: Number(c.leverage_max) } : {}),
        };
      });
  }

  async fetchTickers(symbols: string[]): Promise<Ticker[]> {
    if (symbols.length === 0) return [];
    // 一次拉全量再过滤：逐个 contract 请求会把页面拖到十几秒
    const res = await fetch(`${this.marketBaseUrl}/futures/usdt/tickers`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Gate 合约行情 HTTP ${res.status}`);
    const all = (await res.json()) as GateFuturesTicker[];
    const wanted = new Map(symbols.map((s) => [toContract(s), s]));
    const out: Ticker[] = [];
    for (const t of all) {
      const symbol = t.contract ? wanted.get(t.contract) : undefined;
      if (!symbol || !t.last) continue;
      out.push({
        symbol,
        price: Number(t.last),
        changePct: Number(t.change_percentage ?? 0) / 100,
        volume: Number(t.volume_24h_quote ?? t.volume_24h_base ?? 0),
        timestamp: Date.now(),
      });
    }
    return out;
  }

  async fetchKlines(symbol: string, interval: string, limit: number): Promise<Bar[]> {
    const contract = toContract(symbol);
    const url = `${this.marketBaseUrl}/futures/usdt/candlesticks?contract=${encodeURIComponent(contract)}&interval=${encodeURIComponent(interval)}&limit=${Math.min(Math.max(1, limit), 1000)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Gate 合约 K 线 HTTP ${res.status}`);
    const rows = (await res.json()) as {
      t?: number;
      v?: number;
      c?: string;
      h?: string;
      l?: string;
      o?: string;
    }[];
    if (!Array.isArray(rows)) throw new Error("Gate 合约 K 线返回格式异常");
    const bars = rows
      .filter((r) => r.t !== undefined)
      .map((r) => ({
        symbol,
        timestamp: new Date(Number(r.t) * 1000),
        close: Number(r.c),
        high: Number(r.h),
        low: Number(r.l),
        open: Number(r.o),
        volume: Number(r.v ?? 0),
      }))
      .filter((b) => Number.isFinite(b.open) && Number.isFinite(b.close) && b.close > 0);
    bars.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    log.debug("Gate 合约 K 线 %s %s -> %d 根", contract, interval, bars.length);
    return bars;
  }

  /** 公共盘口（无需密钥）：/futures/usdt/order_book。合约用标记/最新盘口撮合模拟更贴近实盘。 */
  async fetchOrderBook(symbol: string, depth = 50): Promise<OrderBookSnapshot> {
    const contract = toContract(symbol);
    const limit = Math.min(100, Math.max(1, Math.floor(depth)));
    const url = `${this.marketBaseUrl}/futures/usdt/order_book?contract=${encodeURIComponent(contract)}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Gate 合约盘口 HTTP ${res.status}`);
    const raw = (await res.json()) as { current: number; asks: string[][]; bids: string[][] };
    return {
      symbol,
      asks: raw.asks.map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
      bids: raw.bids.map(([p, q]) => ({ price: Number(p), quantity: Number(q) })),
      timestamp: (raw.current ?? 0) * 1000 || Date.now(),
    };
  }

  /**
   * 真实资金费率（公共接口）：/futures/usdt/contracts 里的 funding_rate
   * 为当前周期年化前的瞬时费率（8 小时结算一次，多数交易所惯例）。
   * 模拟合约账户按持仓名义价值 × 费率在结算时刻扣/收。
   */
  async fetchFundingRate(symbol: string): Promise<{ rate: number; nextSettleMs: number | null }> {
    const contract = toContract(symbol);
    const url = `${this.marketBaseUrl}/futures/usdt/contracts/${encodeURIComponent(contract)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Gate 资金费率 HTTP ${res.status}`);
    const raw = (await res.json()) as { funding_rate?: string; funding_next_apply?: number };
    const rate = Number(raw.funding_rate ?? "0");
    return {
      rate: Number.isFinite(rate) ? rate : 0,
      nextSettleMs: raw.funding_next_apply ? raw.funding_next_apply * 1000 : null,
    };
  }
}
