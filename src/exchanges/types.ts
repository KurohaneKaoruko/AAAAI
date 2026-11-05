/**
 * 交易所统一适配层：行情、下单、余额的抽象。
 * 加密货币（Binance / OKX）与股票（东财 / Stooq）都实现这套接口。
 */

import type { Bar, Side } from "../core/types.js";

export type AssetClass = "crypto" | "stock";

/**
 * 交易品种类型。
 * - spot：现货，现金账户，只做多；
 * - futures：永续/合约，保证金账户，允许做空（由策略的 allowShort 决定）。
 *
 * 默认 spot，老适配器不需要改动。
 */
export type TradingMode = "spot" | "futures";

/** 标的元信息。 */
export interface SymbolInfo {
  /** 本适配器内的代码：BTCUSDT / ETHUSDT / AAPL */
  symbol: string;
  name: string;
  assetClass: AssetClass;
  /** 计价货币：USDT / CNY / USD */
  currency: string;
  /** 每手股数（部分市场 100，其余 1） */
  lotSize: number;
  pricePrecision: number;
  qtyPrecision: number;
  /** 合约面值：1 张 = 多少基础币（仅合约标的；现货为 undefined） */
  contractSize?: number;
  /** 交易所允许的最高杠杆（仅合约；只做展示/校验，不改变仓位算法） */
  maxLeverage?: number;
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

/** 订单簿的一档。 */
export interface BookLevel {
  price: number;
  quantity: number;
}

/** 某一时刻的真实订单簿快照（来自交易所公共盘口接口）。 */
export interface OrderBookSnapshot {
  symbol: string;
  /** 按价格从优到劣排序：卖一在前 */
  asks: BookLevel[];
  /** 按价格从优到劣排序：买一在前 */
  bids: BookLevel[];
  /** 快照时刻（epoch ms） */
  timestamp: number;
}

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
  /**
   * 连接级交易模式（现货/合约）。
   *
   * 只对同时支持两种模式的适配器有意义（如 Gate：一条连接既可跑现货对也可跑
   * USDT 永续）。缺省 spot：老连接一律按现货处理，行为不变。
   * 引擎侧（记账/风控/做空许可）以连接实例的 meta.tradingMode 为准，
   * 适配器工厂会把它写进实例 meta。
   */
  tradingMode?: TradingMode;
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
  /** 现货/合约；缺省按 spot 处理，兼容所有老适配器 */
  tradingMode?: TradingMode;
  /**
   * 行情来源：real = 真实交易所/数据商；simulated = 本地生成。
   * 缺省按 real 处理；界面据此决定是否显示“随机行情，不构成证据”的警告。
   */
  marketData?: "real" | "simulated";
  klineIntervals: string[];
  /** 密钥字段（UI 表单渲染） */
  keyFields: KeyField[];
  /** 是否需要额外配置（如 OKX 的 passphrase 复用 secret 字段） */
  notes?: string[];
  /** 常用标的清单：供「一键选取」用，无需输入关键词 */
  defaultSymbols?: SymbolInfo[];
  /**
   * 交易什么由交易所自己决定，用户不需要（界面上也不该）挑选。
   *
   * 模拟交易所就是这种：它的"交易物"是本地生成的几条行情走向，让用户先去
   * 候选池里配一套代码纯属多余 —— 他和什么标的交易根本没有关系。这种连接
   * 的交易物一律取 `defaultSymbols`，候选池对它无效。
   */
  builtinSymbols?: boolean;
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
  /**
   * 真实订单簿快照（公共盘口接口，无需密钥）。
   *
   * 可选能力：实现了它的适配器让模拟撮合升级为**逐档吃真实盘口**
   * （见 execution/bookLiquidity.ts）——成交价由盘口深度决定，不再靠
   * 合成滑点模型猜。未实现的适配器自动退回「下一根开盘价 + 冲击成本」
   * 的旧口径，行为不变。
   */
  fetchOrderBook?(symbol: string, depth?: number): Promise<OrderBookSnapshot>;
  /** K 线，按时间升序。 */
  fetchKlines(symbol: string, interval: string, limit: number): Promise<Bar[]>;
  placeOrder?(req: OrderRequest): Promise<OrderResult>;
  fetchBalances?(): Promise<Balance[]>;
  /**
   * 换一个随机情景（仅本地生成行情的适配器实现，如模拟交易所）。
   *
   * 语义由调用方定义，见各调用点的注释：
   * - 历史模拟每次调用 → 每次重掷一层新噪声（走向形状不变）；
   * - 模拟对照只调用一次 → 所有参赛者面对同一份行情；
   * - 实时轮询不调用 → 保持同一份行情向前延伸。
   *
   * 返回情景种子，会被记进结果，用于复现。
   */
  newScenario?(seed?: number): number;
}

/** 适配器实际交易模式；老适配器缺省为现货。 */
export function tradingModeOf(adapter: ExchangeAdapter): TradingMode {
  return adapter.meta.tradingMode ?? "spot";
}

/** 是否是本地生成行情（随机行情不能当作策略表现的证据）。 */
export function isSimulatedMarket(adapter: ExchangeAdapter): boolean {
  return adapter.meta.marketData === "simulated" || adapter.meta.id === "simulated";
}
