/**
 * Gate.io 统一适配器：一条连接覆盖现货与 USDT 永续两种交易类型。
 *
 * 为什么合并：此前「Gate 现货」和「Gate 合约」是两个适配器、两条连接、两份
 * 密钥配置 —— 用户实际是同一家交易所的同一个账户，分两处管理纯属折磨。
 * 现在交易所目录只有一个 Gate.io：建一条连接，用连接上的 tradingMode
 * 开关选「现货 / 合约」，密钥与连通性只配一份，随时可切。
 *
 * 实现是组合而非重写：现货（gate.ts）与合约（gateFutures.ts）各自的
 * 行情/下单逻辑久经考验，统一层只做三件事：
 * 1. 按连接的 tradingMode 把调用委托给对应实现；
 * 2. 把实例 meta 汇总成「一个 Gate」的目录口径（交易能力取两边的并集）；
 * 3. 实例 meta.tradingMode 写成连接选定的模式 —— 引擎侧的记账方式
 *    （现金 vs 保证金）、做空许可、可用资金注入都从这个字段派生，
 *    因此「同一条连接切换模式」对引擎来说就是两种连接，语义干净。
 */

import type { Bar } from "../core/types.js";
import type {
  AdapterMeta,
  Connection,
  ConnectionTest,
  Credential,
  ExchangeAdapter,
  OrderRequest,
  OrderResult,
  SymbolInfo,
  Ticker,
} from "./types.js";
import { GateAdapter } from "./gate.js";
import { GateFuturesAdapter } from "./gateFutures.js";

/**
 * 目录展示用的合并 meta：两种模式的能力并集。
 * defaultSymbols 取两边的合集（现货对 + 永续合约），挑标的时一目了然。
 */
const CATALOG_META: AdapterMeta = {
  id: "gate",
  name: "Gate.io 芝麻开门",
  assetClass: "crypto",
  description:
    "Gate.io 一条连接通吃现货与 USDT 永续：公开行情走主网真实数据（无需密钥）；下单需 API Key/Secret。建连接时选「合约模式」即按保证金账户记账、允许做空。现货交易对与永续合约都用 BTC_USDT 写法，会自动转换。",
  requiresKeys: true,
  supportsTrading: true,
  supportsTestnet: true,
  klineIntervals: ["10s", "1m", "5m", "15m", "30m", "1h", "4h", "1d"],
  keyFields: [
    { key: "apiKey", label: "API Key", secret: false, placeholder: "粘贴 Gate.io API Key" },
    { key: "apiSecret", label: "API Secret", secret: true, placeholder: "粘贴 Gate.io API Secret" },
  ],
  notes: ["现货与合约共用同一组 API Key；行情始终走主网真实数据。"],
  // 目录清单取现货 + 永续的合集：挑标的时两种都看得到。两边代码写法一致
  // （现货对与合约同名 BTC_USDT），按代码去重——同一连接里它指现货还是
  // 永续由 tradingMode 决定，不需要两个同代码的条目。
  defaultSymbols: (() => {
    const merged = [
      ...(new GateAdapter().meta.defaultSymbols ?? []),
      ...(new GateFuturesAdapter().meta.defaultSymbols ?? []),
    ];
    const seen = new Set<string>();
    return merged.filter((s) => (seen.has(s.symbol) ? false : (seen.add(s.symbol), true)));
  })(),
};

/** 注册表目录项（不含连接信息）。 */
export function gateCatalogMeta(): AdapterMeta {
  return CATALOG_META;
}

/**
 * 统一 Gate 适配器实例：按连接选定的模式委托。
 * 两个内部实现各自持有独立状态（密钥缓存等），切换模式 = 换委托对象。
 */
export class GateUnifiedAdapter implements ExchangeAdapter {
  /** 连接选定的模式（构造时定死；meta 与委托都用它）。必须最先声明：后面的字段初始化器要用它。 */
  private readonly mode: "spot" | "futures";
  private spot = new GateAdapter();
  private futures = new GateFuturesAdapter();

  /** 目录/引擎口径的元信息：交易模式派生自连接，合约模式换合约描述与标的清单。 */
  readonly meta: AdapterMeta;

  constructor(connection?: Pick<Connection, "tradingMode">) {
    this.mode = connection?.tradingMode === "futures" ? "futures" : "spot";
    this.meta = {
      ...CATALOG_META,
      // 引擎按实例 meta.tradingMode 决定记账与做空许可 —— 这里必须是连接选定的模式，
      // 而不是目录里静态写死的那个。
      tradingMode: this.mode,
      description:
        this.mode === "futures"
          ? "Gate.io USDT 永续（合约模式）：主网真实合约行情，本地保证金记账、支持做空；真实合约下单未开放。切回现货模式可交易现货对。"
          : CATALOG_META.description,
      defaultSymbols:
        this.mode === "futures" ? this.futures.meta.defaultSymbols : this.spot.meta.defaultSymbols,
    };
  }

  /** 当前生效的委托实现。 */
  private get impl(): ExchangeAdapter {
    return this.mode === "futures" ? this.futures : this.spot;
  }

  init(cred: Credential): void {
    // 两边都初始化：用户随时可能切换模式，密钥不应只在一边生效。
    this.spot.init(cred);
    this.futures.init(cred);
  }

  testConnection(): Promise<ConnectionTest> {
    return this.impl.testConnection();
  }

  searchSymbols(query: string, limit?: number): Promise<SymbolInfo[]> {
    return this.impl.searchSymbols(query, limit);
  }

  fetchTickers(symbols: string[]): Promise<Ticker[]> {
    return this.impl.fetchTickers(symbols);
  }

  fetchKlines(symbol: string, interval: string, limit: number): Promise<Bar[]> {
    return this.impl.fetchKlines(symbol, interval, limit);
  }

  placeOrder(req: OrderRequest): Promise<OrderResult> {
    // 合约侧 supportsTrading=false（真实合约下单未开放），委托过去会抛出说明性错误；
    // 现货侧正常执行。行为与拆分时代完全一致。
    const impl = this.impl;
    return impl.placeOrder ? impl.placeOrder(req) : Promise.reject(new Error("该适配器不支持下单"));
  }
}
