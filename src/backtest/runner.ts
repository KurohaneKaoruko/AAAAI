/**
 * 历史模拟（回测）：把一段真实历史行情灌进流水线，看策略在那段时间的表现。
 *
 * 与机器人的边界（重要，别混）：
 * - 机器人 = 实时实体。决策来自实时行情、成交随实时 K 线产生、统计就是它的实时操作。
 *   预热只喂指标不成交，所以"一启动几十笔成交"不可能出现。
 * - 本模块 = 历史回放。它**就是**要把整段历史跑完来回答"这套参数在那段时间行不行"，
 *   成交当然一次性全出。它不属于任何机器人，也不写机器人的任何统计。
 *
 * 那些一启动就冒出来的成交没有消失，只是搬到了该在的地方。
 */

import { buildPipeline, feed } from "../agents/orchestrator.js";
import type { AppConfig } from "../configSchema.js";
import type { Bar, TradeRecord } from "../core/types.js";
import type { ExchangeAdapter } from "../exchanges/types.js";
import { strategyFields, type StrategyProfile } from "../strategies/profileStore.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("backtest");

export interface BacktestInput {
  symbols: string[];
  interval: string;
  /** 取多少根 K 线 */
  barCount: number;
  strategyId: string;
  /** 初始资金（不填用全局风控配置） */
  initialCash?: number;
  /** 回撤熔断（不填用全局风控配置） */
  maxDrawdownPct?: number;
  /** 最小调仓额（不填用全局风控配置） */
  minTradeValue?: number;
}

export interface BacktestResult {
  symbols: string[];
  interval: string;
  barCount: number;
  /** 实际参与回放的 K 线数 */
  bars: number;
  durationMs: number;
  strategyId: string;
  strategyName: string;
  decisionSource: string;
  metrics: {
    finalEquity: number;
    cash: number;
    openPositions: number;
    totalFills: number;
    maxDrawdownPct: number;
    realizedPnl: number;
    equityPoints: number;
    totalReturn: number;
  };
  equityCurve: { timestamp: string; equity: number }[];
  trades: TradeRecord[];
  pnlBySymbol: { symbol: string; realizedPnl: number; fills: number }[];
}

/** 回测只跑能在本地完整复现的决策路：模型调用有时延/费用，属于「模拟对照」的职责。 */
function assertLocalDecisionSource(profile: StrategyProfile): void {
  const src = profile.decisionSource;
  if (src === "chat" || src === "systemone" || src === "hybrid") {
    throw new Error(
      `策略「${profile.name}」的决策来源是${src === "hybrid" ? "混合决策" : "大模型"}，回测不支持：` +
        `模型调用有延迟与费用，且回放里问模型等于用后见之明，历史成绩会虚高。` +
        `量化交易策略可在此回测；模型对比请用「模拟对照」页。`,
    );
  }
}

/** 跑一段历史。异常会直接抛给路由层转成 4xx/5xx。 */
export async function runBacktest(
  config: AppConfig,
  adapter: ExchangeAdapter,
  profile: StrategyProfile,
  input: BacktestInput,
): Promise<BacktestResult> {
  assertLocalDecisionSource(profile);

  const started = Date.now();
  const cfg: AppConfig = {
    ...config,
    strategy: { ...config.strategy, ...strategyFields(profile) },
    risk: {
      ...config.risk,
      ...(input.initialCash !== undefined ? { initialCash: input.initialCash } : {}),
      ...(input.maxDrawdownPct !== undefined ? { maxDrawdownPct: input.maxDrawdownPct } : {}),
      ...(input.minTradeValue !== undefined ? { minTradeValue: input.minTradeValue } : {}),
    },
  };

  // 回测永远是本地撮合：它回答"策略行不行"，不碰任何真实账户
  const pipeline = buildPipeline(cfg, { adapter, liveTrading: false });

  const groups = await Promise.all(
    input.symbols.map((s) => adapter.fetchKlines(s, input.interval, input.barCount)),
  );
  const bars: Bar[] = groups.flat().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  if (bars.length === 0) {
    throw new Error("没有取到任何 K 线：请检查连接、标的与周期");
  }
  await feed(pipeline, bars);

  const portfolio = pipeline.portfolio;
  const m = portfolio.metrics();
  const realized = portfolio.realizedPnl();
  const initialCash = cfg.risk.initialCash;
  const trades = portfolio.tradeHistory();
  const bySymbol = new Map<string, { realizedPnl: number; fills: number }>();
  for (const t of trades) {
    const agg = bySymbol.get(t.symbol) ?? { realizedPnl: 0, fills: 0 };
    agg.realizedPnl += t.realizedPnl;
    agg.fills += 1;
    bySymbol.set(t.symbol, agg);
  }

  log.info(
    "回测 %s %s %d 根: 权益 %.2f 成交 %d",
    input.symbols.join(","),
    input.interval,
    bars.length,
    m.finalEquity,
    m.totalFills,
  );

  return {
    symbols: input.symbols,
    interval: input.interval,
    barCount: input.barCount,
    bars: bars.length,
    durationMs: Date.now() - started,
    strategyId: profile.id,
    strategyName: profile.name,
    decisionSource: profile.decisionSource,
    metrics: {
      ...m,
      realizedPnl: Number(realized.toFixed(4)),
      totalReturn: initialCash > 0 ? (m.finalEquity - initialCash) / initialCash : 0,
    },
    equityCurve: portfolio.equityCurve(),
    trades,
    pnlBySymbol: [...bySymbol.entries()]
      .map(([symbol, agg]) => ({ symbol, realizedPnl: Number(agg.realizedPnl.toFixed(2)), fills: agg.fills }))
      .sort((a, b) => b.realizedPnl - a.realizedPnl),
  };
}
