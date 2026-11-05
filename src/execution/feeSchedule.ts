/**
 * 交易所真实费率表（taker / maker）。
 *
 * 为什么不用单一 feeRate：真实交易所现货吃单（taker）与挂单（maker）
 * 费率不同，且各所差异巨大（Binance VIP0 现货 taker 0.1%，Gate 同档
 * 0.2%，OKX 0.1%）。模拟撮合若一律用 0.03% 这类"行业平均"，成本核算
 * 会与真实账户对不上账。这里按适配器给默认费率，用户配置的 risk.feeRate
 * 仍然优先（显式配置 = 用户知道自己那家交易所的档位）。
 *
 * 费率为公开常识值（2026-11 各所官方费率页的普通用户档），只作模拟撮合
 * 的合理缺省，不承诺与用户实际档位一致——界面上注明可在风控页覆盖。
 */

/** taker（吃单）与 maker（挂单）费率对。 */
export interface FeePair {
  taker: number;
  maker: number;
}

/** 各适配器的默认费率（小数：0.001 = 0.1%）。 */
const SCHEDULE: Record<string, FeePair> = {
  // Binance 现货 VIP0：0.1% / 0.1%（有 BNB 抵扣可打折，这里按不抵扣的保守值）
  binance: { taker: 0.001, maker: 0.001 },
  // Gate 现货普通档：0.2% / 0.2%（GT 抵扣可降，按不抵扣保守值）
  gate: { taker: 0.002, maker: 0.002 },
  // OKX 现货普通用户：0.1% / 0.08%
  okx: { taker: 0.001, maker: 0.0008 },
  // Gate USDT 永续：taker 0.05% / maker 0.02%
  "gate-futures": { taker: 0.0005, maker: 0.0002 },
  // Stooq 只是行情源（美股模拟成交），按美股常见零佣金券商给 0
  stooq: { taker: 0, maker: 0 },
};

const UNKNOWN: FeePair = { taker: 0.001, maker: 0.001 };

/** 按适配器 ID 取费率；合约模式按合约口径。 */
export function feePairFor(adapterId: string, tradingMode: "spot" | "futures" = "spot"): FeePair {
  // 统一 gate 连接的合约模式用合约费率
  if (adapterId === "gate" && tradingMode === "futures") return SCHEDULE["gate-futures"]!;
  return SCHEDULE[adapterId] ?? UNKNOWN;
}
