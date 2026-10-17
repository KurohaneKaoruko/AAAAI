/**
 * 多情景胜率：把「大部分场景盈利为正」变成一个可测量的数字。
 *
 * 「这套参数行不行」与「这套参数稳不行」是两个问题。单次回测只回答第一个，
 * 而且答案里混着大量运气 —— 同一套参数换一条噪声路径就可能从赚变亏。
 * 本模块在模拟交易所上把同一套参数跑 N 条不同的随机路径，输出：
 *
 * - winRate：正收益率（期末 > 本金，即「资金的 100% 以上」）的场景占比；
 * - median / worst：中位与最差收益率 —— 中位回答「典型情况」，
 *   最差回答「最坏的时候亏多少」，这两个比平均值诚实（平均值会被
 *   一两条大赚的路径拉高，掩盖常常小亏的事实）；
 * - byRegime：分走向统计 —— 同一策略在单边上行里赢不算本事，
 *   在急速跳水里少亏才是。
 *
 * 边界（与回测/对照一致，不破例）：
 * - 只跑本地可复现的决策路（量化规则）；模型类策略请用「模拟对照」；
 * - 每条路径都是独立情景（各自 newScenario），互不共享行情；
 * - 结果不可用于真实市场的外推：模拟交易所的走向形状是写死的，
 *   这里测的是「参数对噪声与不同走向的稳健性」，不是「未来会赚」。
 */

import { runBacktest } from "../backtest/runner.js";
import type { StrategyProfile } from "../strategies/profileStore.js";
import type { ExchangeAdapter } from "../exchanges/types.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("scenario-winrate");

export interface WinRateOptions {
  /** 跑多少条独立随机路径（默认 24） */
  scenarios?: number;
  interval?: string;
  barCount?: number;
  initialCash?: number;
  /** 每条路径的回撤熔断（不填用全局风控配置） */
  maxDrawdownPct?: number;
  /** 固定第一颗种子 = 可复现的胜率报告（其余路径由它派生） */
  seed?: number;
}

export interface ScenarioOutcome {
  /** 情景种子（填回去可单独重跑这条路径核对） */
  seed: number;
  /** 期末权益 / 初始资金 − 1 */
  returnPct: number;
  /** 期末权益是否 > 本金（用户口径里的「100% 以上」） */
  positive: boolean;
  maxDrawdownPct: number;
  fills: number;
}

export interface RegimeStat {
  /** 走向（模拟交易所的交易物） */
  regime: string;
  runs: number;
  positiveRuns: number;
  medianReturn: number;
  worstReturn: number;
}

export interface WinRateReport {
  scenarios: number;
  interval: string;
  barCount: number;
  /** 正收益场景占比（0~1）。headline 数字，但必须和 median/worst 一起看 */
  winRate: number;
  medianReturn: number;
  worstReturn: number;
  bestReturn: number;
  /** 平均收益率（仅供参考，会被极端路径拉偏） */
  avgReturn: number;
  outcomes: ScenarioOutcome[];
  /** 分走向统计（只统计单走向运行；混合运行不归入任何一类） */
  byRegime: RegimeStat[];
  /** 本次报告的起始种子（复现整份报告用） */
  seed: number;
}

/** 由起始种子派生第 i 条路径的种子：确定、离散、可复现。 */
function deriveSeed(base: number, i: number): number {
  // 乘大素数 + 异或雪崩，避免「种子 i 和 i+1 的路径高度相似」；
  // >>>0 保证落在 uint32。
  return (Math.imul(base ^ 0x9e3779b9, 2654435761) + Math.imul(i + 1, 40503)) >>> 0;
}

/**
 * 跑多情景胜率。
 *
 * adapter 必须是**独立实例**（engineController.independentAdapter）：
 * 每条路径都要 newScenario，不能掷在实时机器人正在用的那个实例上。
 * symbols 传单条走向时 byRegime 才有意义；传多条时是「组合在该情景下的表现」。
 */
export async function runWinRate(
  config: Parameters<typeof runBacktest>[0],
  adapter: ExchangeAdapter,
  profile: StrategyProfile,
  symbols: string[],
  options: WinRateOptions = {},
): Promise<WinRateReport> {
  if (adapter.meta.id !== "simulated") {
    throw new Error(
      "多情景胜率只在模拟交易所上跑：它需要反复掷新的随机路径，真实行情给不出「不同场景」。",
    );
  }
  if (symbols.length === 0) throw new Error("至少要有一条走向/标的");

  const scenarios = Math.max(2, Math.min(options.scenarios ?? 24, 200));
  const interval = options.interval ?? "1m";
  const barCount = options.barCount ?? 200;
  const baseSeed = options.seed ?? Math.floor(Math.random() * 0xffffffff) >>> 0;

  const outcomes: ScenarioOutcome[] = [];
  for (let i = 0; i < scenarios; i += 1) {
    const seed = deriveSeed(baseSeed, i);
    const r = await runBacktest(config, adapter, profile, {
      symbols,
      interval,
      barCount,
      strategyId: profile.id,
      ...(options.initialCash !== undefined ? { initialCash: options.initialCash } : {}),
      ...(options.maxDrawdownPct !== undefined ? { maxDrawdownPct: options.maxDrawdownPct } : {}),
      scenarioSeed: seed,
    });
    outcomes.push({
      seed,
      returnPct: r.metrics.totalReturn,
      positive: r.metrics.totalReturn > 0,
      maxDrawdownPct: r.metrics.maxDrawdownPct,
      fills: r.metrics.totalFills,
    });
  }

  const returns = outcomes.map((o) => o.returnPct).sort((a, b) => a - b);
  const winRate = outcomes.filter((o) => o.positive).length / outcomes.length;
  const median = returns[Math.floor(returns.length / 2)]!;
  const report: WinRateReport = {
    scenarios,
    interval,
    barCount,
    winRate,
    medianReturn: median,
    worstReturn: returns[0]!,
    bestReturn: returns[returns.length - 1]!,
    avgReturn: returns.reduce((a, b) => a + b, 0) / returns.length,
    outcomes,
    byRegime: [],
    seed: baseSeed,
  };

  // 分走向统计：单走向运行才有归因意义（混合运行里赚的是组合的钱，说不清是哪条走向的功劳）
  if (symbols.length === 1) {
    const regime = symbols[0]!;
    const sorted = outcomes.map((o) => o.returnPct).sort((a, b) => a - b);
    report.byRegime.push({
      regime,
      runs: outcomes.length,
      positiveRuns: outcomes.filter((o) => o.positive).length,
      medianReturn: sorted[Math.floor(sorted.length / 2)]!,
      worstReturn: sorted[0]!,
    });
  }

  log.info(
    "多情景胜率 %s×%d根×%d条: winRate=%s median=%s worst=%s",
    symbols.join(","),
    barCount,
    scenarios,
    (winRate * 100).toFixed(0) + "%",
    (median * 100).toFixed(2) + "%",
    (report.worstReturn * 100).toFixed(2) + "%",
  );
  return report;
}
