/**
 * 多情景胜率：把「大部分场景盈利为正」变成一个可测量的数字。
 *
 * 「这套参数行不行」与「这套参数稳不行」是两个问题。单次回测只回答第一个，
 * 而且答案里混着大量运气 —— 同一套参数换一条噪声路径就可能从赚变亏。
 * 本模块在模拟交易所上把同一套参数跑 N 条不同的随机路径，输出：
 *
 * - winRate：正收益率（期末 > 本金，即「资金的 100% 以上」）的场景占比；
 * - 保本/亏损分开数：没成交的路径资金原封不动（保本），它既不是盈利，
 *   也不该被笼统归进「亏」；分开数才看得清「不交易躲过下跌」这件事；
 * - median / worst：中位与最差收益率 —— 中位回答「典型情况」，
 *   最差回答「最坏的时候亏多少」，这两个比平均值诚实（平均值会被
 *   一两条大赚的路径拉高，掩盖常常小亏的事实）；
 * - byRegime：分走向统计 —— 同一策略在单边上行里赢不算本事，
 *   在急速跳水里少亏才是。多走向时逐条走向各跑一份（同一批种子），
 *   它是「该走向单独跑」的成绩，不是把组合盈亏拆到各走向头上。
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
  /**
   * 多走向时是否逐走向再各跑一份（默认开）。
   * 开销是「条数 × 走向数」，换来分走向归因；单走向调用不受影响。
   */
  perRegime?: boolean;
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
  /** 完全没成交（没交手续费，资金原封不动）的条数 */
  flatRuns: number;
  medianReturn: number;
  worstReturn: number;
}

export interface WinRateReport {
  scenarios: number;
  interval: string;
  barCount: number;
  /** 本次跑的是哪些走向/标的（组合口径） */
  symbols: string[];
  /** 正收益场景占比（0~1）。headline 数字，但必须和 median/worst 一起看 */
  winRate: number;
  positiveRuns: number;
  /** 保本（没成交）条数 */
  flatRuns: number;
  /** 亏损条数 */
  negativeRuns: number;
  medianReturn: number;
  worstReturn: number;
  bestReturn: number;
  /** 平均收益率（仅供参考，会被极端路径拉偏） */
  avgReturn: number;
  outcomes: ScenarioOutcome[];
  /** 分走向统计（逐走向单独跑的成绩；组合盈亏不拆到各走向） */
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

interface SweepOptions {
  scenarios: number;
  interval: string;
  barCount: number;
  baseSeed: number;
  initialCash?: number;
  maxDrawdownPct?: number;
}

/** 一批路径：同一批派生种子上逐条跑回测。串行执行 —— 适配器只有一个情景种子，并发跑会互相改写。 */
async function sweep(
  config: Parameters<typeof runBacktest>[0],
  adapter: ExchangeAdapter,
  profile: StrategyProfile,
  symbols: string[],
  opts: SweepOptions,
): Promise<ScenarioOutcome[]> {
  const outcomes: ScenarioOutcome[] = [];
  for (let i = 0; i < opts.scenarios; i += 1) {
    const seed = deriveSeed(opts.baseSeed, i);
    const r = await runBacktest(config, adapter, profile, {
      symbols,
      interval: opts.interval,
      barCount: opts.barCount,
      strategyId: profile.id,
      ...(opts.initialCash !== undefined ? { initialCash: opts.initialCash } : {}),
      ...(opts.maxDrawdownPct !== undefined ? { maxDrawdownPct: opts.maxDrawdownPct } : {}),
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
  return outcomes;
}

/** 中位（偶数条取靠中偏小的那条，与页面表格的口径一致：只做展示，不做统计推断）。 */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** 由一批结果生成一条分走向统计（单走向调用与多走向归因共用）。 */
function regimeStat(regime: string, outcomes: ScenarioOutcome[]): RegimeStat {
  const counts = tally(outcomes);
  const rets = outcomes.map((o) => o.returnPct);
  return {
    regime,
    runs: outcomes.length,
    positiveRuns: counts.positiveRuns,
    flatRuns: counts.flatRuns,
    medianReturn: medianOf(rets),
    worstReturn: Math.min(...rets),
  };
}

/** 从一批结果里数正/保本/亏 —— 一条路径只有一个归属，三者之和恒等于条数。 */
function tally(outcomes: ScenarioOutcome[]): { positiveRuns: number; flatRuns: number } {
  return {
    positiveRuns: outcomes.filter((o) => o.positive).length,
    // 保本 = 完全没成交：没交易就没手续费，资金原封不动（returnPct 恰为 0）
    flatRuns: outcomes.filter((o) => o.fills === 0).length,
  };
}

/**
 * 跑多情景胜率。
 *
 * adapter 必须是**独立实例**（engineController.independentAdapter）：
 * 每条路径都要 newScenario，不能掷在实时机器人正在用的那个实例上。
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
  const sweepOpts: SweepOptions = {
    scenarios,
    interval,
    barCount,
    baseSeed,
    ...(options.initialCash !== undefined ? { initialCash: options.initialCash } : {}),
    ...(options.maxDrawdownPct !== undefined ? { maxDrawdownPct: options.maxDrawdownPct } : {}),
  };

  const outcomes = await sweep(config, adapter, profile, symbols, sweepOpts);
  const returns = outcomes.map((o) => o.returnPct);
  const { positiveRuns, flatRuns } = tally(outcomes);
  const report: WinRateReport = {
    scenarios,
    interval,
    barCount,
    symbols: [...symbols],
    winRate: positiveRuns / outcomes.length,
    positiveRuns,
    flatRuns,
    negativeRuns: outcomes.length - positiveRuns - flatRuns,
    medianReturn: medianOf(returns),
    worstReturn: Math.min(...returns),
    bestReturn: Math.max(...returns),
    avgReturn: returns.reduce((a, b) => a + b, 0) / returns.length,
    outcomes,
    byRegime: [],
    seed: baseSeed,
  };

  // 分走向归因：单走向调用直接复用本次结果；多走向时逐条走向各跑一份
  // （同一批种子，可比）。它是「该走向单独跑」的成绩 —— 组合里赚的钱不拆到各走向头上。
  if (options.perRegime ?? true) {
    if (symbols.length === 1) {
      report.byRegime.push(regimeStat(symbols[0]!, outcomes));
    } else {
      for (const regime of symbols) {
        report.byRegime.push(regimeStat(regime, await sweep(config, adapter, profile, [regime], sweepOpts)));
      }
    }
  }

  log.info(
    "多情景胜率 %s×%d根×%d条: 正=%d 保本=%d 亏=%d median=%s worst=%s",
    symbols.join(","),
    barCount,
    scenarios,
    positiveRuns,
    flatRuns,
    report.negativeRuns,
    (report.medianReturn * 100).toFixed(2) + "%",
    (report.worstReturn * 100).toFixed(2) + "%",
  );
  return report;
}
