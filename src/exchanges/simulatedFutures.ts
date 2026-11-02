/**
 * 模拟合约交易所：复用模拟交易所的五条行情走向，但按**合约账户**记账。
 *
 * 和现货模拟交易所的区别只在交易层：
 * - 允许策略做空（由策略的 allowShort 决定）；
 * - 组合权益 = 保证金现金 + 未实现盈亏，而不是「现金 + 持仓市值」；
 * - 开仓不占用全额现金，但组合总名义敞口仍受风控上限约束。
 *
 * 仍然不模拟资金费、逐仓强平与交易所保证金率 —— 这些是真实合约才有的风险，
 * 界面必须如实说明；本适配器只用于验证方向/仓位逻辑，不构成收益证据。
 */

import type { AdapterMeta, ConnectionTest, ExchangeAdapter, SymbolInfo } from "./types.js";
import { SimulatedAdapter } from "./simulated.js";

const CONTRACT_SYMBOLS: SymbolInfo[] = [
  { symbol: "单边上行", name: "稳步抬升的上涨行情", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 2, qtyPrecision: 6, contractSize: 1 },
  { symbol: "缓慢阴跌", name: "小步下滑的阴跌行情", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 2, qtyPrecision: 6, contractSize: 1 },
  { symbol: "震荡整理", name: "区间来回的横盘行情", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 2, qtyPrecision: 6, contractSize: 1 },
  { symbol: "急速跳水", name: "横盘后急速下跌的恐慌行情", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 2, qtyPrecision: 6, contractSize: 1 },
  { symbol: "急涨急跌", name: "先急涨再急跌的甩人行情", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 2, qtyPrecision: 6, contractSize: 1 },
];

export class SimulatedFuturesAdapter extends SimulatedAdapter implements ExchangeAdapter {
  readonly meta: AdapterMeta = {
    id: "simulated-futures",
    name: "模拟合约（USDT 永续）",
    assetClass: "crypto",
    description:
      "本地生成的永续合约行情：五种走向叠加随机噪声，按保证金账户记账，支持双向持仓。仅用于策略验证；不模拟资金费、强平与交易所保证金率。",
    requiresKeys: false,
    supportsTrading: true,
    supportsTestnet: false,
    tradingMode: "futures",
    marketData: "simulated",
    klineIntervals: ["1s", "5s", "15s", "30s", "1m", "5m", "15m", "1h", "4h", "1d"],
    keyFields: [],
    defaultSymbols: CONTRACT_SYMBOLS,
    builtinSymbols: true,
    notes: [
      "无需密钥；行情是本地生成，不是任何真实市场",
      "支持做空，组合按保证金账户计算：权益 = 现金 + 未实现盈亏",
      "不模拟资金费、逐仓强平、维持保证金与交易所强平引擎",
      "每次历史模拟/多情景胜率都会重掷噪声；模拟对照可多轮跑同一批选手",
      "真实合约下单未在此适配器开放；真实行情请用 Gate.io 合约连接",
    ],
  };

  async testConnection(): Promise<ConnectionTest> {
    return {
      ok: true,
      message: `模拟合约始终可用（本地行情，当前情景种子 ${this.seed}；不模拟资金费/强平）`,
    };
  }

  async searchSymbols(query: string, limit = 20): Promise<SymbolInfo[]> {
    const q = query.trim().toUpperCase();
    return CONTRACT_SYMBOLS.filter(
      (s) => !q || s.symbol.toUpperCase().includes(q) || s.name.includes(query.trim()),
    ).slice(0, limit);
  }
}
