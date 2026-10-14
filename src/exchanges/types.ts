/**
 * 交易所统一适配层：行情、下单、余额的抽象。
 * 加密货币（Binance / OKX）与股票（东财 / Stooq）都实现这套接口。
 */

import type { Bar, Side } from "../core/types.js";

export type AssetClass = "crypto" | "stock";

/** 标的元信息。 */
export interface SymbolInfo {
  /** 本适配器内的代码：BTCUSDT / 600519 / AAPL */
  symbol: string;
  name: string;
  assetClass: AssetClass;
  /** 计价货币：USDT / CNY / USD */
  currency: string;
  /** 每手股数（A 股 100，其余 1） */
  lotSize: number;
  pricePrecision: number;
  qtyPrecision: number;
}

/** 实时快照。 */
export interface Ticker {
  symbol: string;
  price: number;
  /** 涨跌幅（小数，0.01 = 1%） */
  changePct: number;
  volume: number;
  timestamp: number;
}

export type OrderType = "MARKET" | "LIMIT";

export interface OrderRequest {
  symbol: string;
  side: Side;
  type: OrderType;
  /** 基础货币数量（股/币数） */
  quantity?: number;
  /** 报价货币数量（金额，市价买入用） */
  quoteQty?: number;
  /** LIMIT 限价 */
  price?: number;
}

export interface OrderResult {
  orderId: string;
  status: "filled" | "rejected";
  filledQty: number;
  avgPrice: number;
  fee: number;
  message?: string;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
}

export interface ConnectionTest {
  ok: boolean;
  message: string;
}

/** 交易所连接（密钥由 ConnectionManager 保管，不在此存放）。 */
export interface Connection {
  id: string;
  /** 适配器 ID */
  adapterId: string;
  /** 用户自定义名称 */
  label: string;
  /** 是否测试网/模拟盘 */
  testnet: boolean;
  enabled: boolean;
  createdAt: string;
}

/** UI 展示用的适配器元信息。 */
export interface AdapterMeta {
  id: string;
  name: string;
  assetClass: AssetClass | "mixed";
  description: string;
  /** 交易是否需要 API Key */
  requiresKeys: boolean;
  supportsTrading: boolean;
  supportsTestnet: boolean;
  klineIntervals: string[];
  /** 密钥字段（UI 表单渲染） */
  keyFields: KeyField[];
  /** 是否需要额外配置（如 OKX 的 passphrase 复用 secret 字段） */
  notes?: string[];
}

export interface KeyField {
  key: "apiKey" | "apiSecret";
  label: string;
  secret: boolean;
  placeholder?: string;
}

export interface Credential {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

export interface ExchangeAdapter {
  readonly meta: AdapterMeta;
  init(cred: Credential): void;
  testConnection(): Promise<ConnectionTest>;
  /** 搜索标的（代码/名称模糊匹配）。 */
  searchSymbols(query: string, limit?: number): Promise<SymbolInfo[]>;
  /** 批量行情快照。 */
  fetchTickers(symbols: string[]): Promise<Ticker[]>;
  /** K 线，按时间升序。 */
  fetchKlines(symbol: string, interval: string, limit: number): Promise<Bar[]>;
  placeOrder?(req: OrderRequest): Promise<OrderResult>;
  fetchBalances?(): Promise<Balance[]>;
}
