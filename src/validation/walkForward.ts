/**
 * 前推验证与稳健性体检：让"回测赚钱"这件事变得可信。
 *
 * 现状的问题很实在：参数是在同一段数据上挑的，收益又在这段数据上评，
 * 于是"最优参数"往往只是过拟合的产物。本模块做两件事：
 *
 * 1) Walk-forward（前推验证）
 *    把历史切成若干折，每折用「前面的窗口」评估当前参数、在「后面的窗口」看真实表现，
 *    输出样本内(IS) 与样本外(OOS) 的落差。落差越大 = 越可能过拟合。
 *
 * 2) 参数稳健性（plateau 检测）
 *    在参数网格上扫一遍，看最优参数周围是不是「平台」。
 *    尖峰 = 过拟合（换个参数就崩），平台 = 真有信号。
 *
 * 说明：这些都是「评估工具」，不参与交易决策；结果给用户自己判断。
 */

import { getLogger } from "../core/logger.js";
import { runBacktest } from "../backtest/engine.js";
import type { AppConfig } from "../configSchema.js";
import type { ExchangeAdapter } from "../exchanges/types.js";
import { mergeBarsByTime } from "../data/streaming.js";
import type { Bar } from "../core/types.js";

const log = getLogger("validation");

export interface WalkForwardOptions {
  adapter: ExchangeAdapter;
  symbols: string[];
  interval: string;
  /** 每折长度（K 线根数） */
  foldBars?: number;
  /** 折数（含最后一折作为样本外） */
  folds?: number;
}

export interface FoldResult {
  fold: number;
  isBars: number;
  oosBars: number;
  /** 样本内收益率 */
  isReturn: number;
  /** 样本外收益率 */
  oosReturn: number;
  /** 样本外成交笔数 */
  oosFills: number;
  /** IS 与 OOS 的落差（正 = 过拟合迹象） */
  gap: number;
}

export interface RobustnessCell {
  fast: number;
  slow: number;
  targetWeight: number;
  returnPct: number;
  drawdown: number;
  fills: number;
}

export interface RobustnessReport {
  /** 网格最佳（样本内） */
  best: RobustnessCell | null;
  /** 网格整体中位数，参考基准 */
  median: number;
  /** 最优参数周围的「平台」：与最优收益差距在 10% 以内的格子占比 */
  plateauRatio: number;
  /** 尖峰判定：平台占比过低说明过拟合 */
  overfitRisk: boolean;
  cells: RobustnessCell[];
}

export interface ValidationView {
  walkForward: {
    folds: FoldResult[];
    /** 平均样本外收益率 */
    avgOosReturn: number;
    /** 平均落差 */
    avgGap: number;
    oosPositiveRatio: number;
  };
  robustness: RobustnessReport;
}

/** 取指定窗口的 K 线（按时间切分，多标的合并后排序）。 */
function sliceBars(all: Bar[], from: number, to: number): Bar[] {
  const start = all[from]?.timestamp.getTime() ?? 0;
  const end = all[Math.min(to, all.length) - 1]?.timestamp.getTime() ?? Infinity;
  return all.filter((b) => {
    const t = b.timestamp.getTime();
    return t >= start && t <= end;
  });
}

/** 前推验证：每折「用前 window 看表现，用后 window 检验」。 */
export async function walkForward(
  config: AppConfig,
  options: WalkForwardOptions,
): Promise<ValidationView["walkForward"]> {
  const foldBars = options.foldBars ?? 120;
  const folds = Math.max(2, options.folds ?? 4);
  const groups = await Promise.all(
    options.symbols.map((s) => options.adapter.fetchKlines(s, options.interval, foldBars * folds)),
  );
  const all = mergeBarsByTime(groups);
  if (all.length < foldBars * 2) {
    return { folds: [], avgOosReturn: 0, avgGap: 0, oosPositiveRatio: 0 };
  }

  const results: FoldResult[] = [];
  const step = Math.max(1, Math.floor(all.length / folds));
  for (let f = 0; f < folds; f++) {
    const isFrom = Math.max(0, f * step - foldBars);
    const isTo = f * step + step;
    const oosFrom = f * step;
    const oosTo = Math.min(all.length, oosFrom + step);
    if (isTo - isFrom < 30 || oosTo - oosFrom < 30) continue;

    const is = await evalWindow(config, options, sliceBars(all, isFrom, isTo));
    const oos = await evalWindow(config, options, sliceBars(all, oosFrom, oosTo));
    results.push({
      fold: f + 1,
      isBars: isTo - isFrom,
      oosBars: oosTo - oosFrom,
      isReturn: is.returnPct,
      oosReturn: oos.returnPct,
      oosFills: oos.fills,
      gap: is.returnPct - oos.returnPct,
    });
    log.info("第 %d 折：样本内 %s -> 样本外 %s", f + 1, pct(is.returnPct), pct(oos.returnPct));
  }

  const n = results.length || 1;
  return {
    folds: results,
    avgOosReturn: results.reduce((a, r) => a + r.oosReturn, 0) / n,
    avgGap: results.reduce((a, r) => a + r.gap, 0) / n,
    oosPositiveRatio: results.length === 0 ? 0 : results.filter((r) => r.oosReturn > 0).length / results.length,
  };
}

async function evalWindow(
  config: AppConfig,
  options: WalkForwardOptions,
  bars: Bar[],
): Promise<{ returnPct: number; fills: number; drawdown: number }> {
  if (bars.length < 30) return { returnPct: 0, fills: 0, drawdown: 0 };
  const res = await runBacktest(config, {
    adapter: options.adapter,
    symbols: options.symbols,
    bars: bars.length,
    interval: options.interval,
    liveTrading: false,
  });
  const initial = config.risk.initialCash;
  return {
    returnPct: initial > 0 ? (res.metrics.finalEquity - initial) / initial : 0,
    fills: res.metrics.totalFills,
    drawdown: res.metrics.maxDrawdownPct,
  };
}

/**
 * 参数稳健性：在小网格上扫参数，看最优值是不是「平台」。
 * 只扫三个最影响结果的参数，网格大小可控（默认 3×3×2）。
 */
export async function robustness(
  config: AppConfig,
  options: { adapter: ExchangeAdapter; symbols: string[]; interval: string; bars?: number; grid?: { fast: number[]; slow: number[]; weight: number[] } },
): Promise<RobustnessReport> {
  const bars = options.bars ?? 200;
  const groups = await Promise.all(options.symbols.map((s) => options.adapter.fetchKlines(s, options.interval, bars)));
  const all = mergeBarsByTime(groups);
  const grid = options.grid ?? {
    fast: [3, 5, 8],
    slow: [15, 20, 30],
    weight: [0.3, 0.6],
  };

  const cells: RobustnessCell[] = [];
  for (const fast of grid.fast) {
    for (const slow of grid.slow) {
      if (fast >= slow) continue; // 非法组合直接跳过，不静默出数
      for (const targetWeight of grid.weight) {
        const cfg: AppConfig = {
          ...config,
          strategy: { ...config.strategy, fastWindow: fast, slowWindow: slow, maxTargetWeight: targetWeight },
        };
        const r = await evalWindow(cfg, options, all);
        cells.push({ fast, slow, targetWeight, returnPct: r.returnPct, drawdown: r.drawdown, fills: r.fills });
      }
    }
  }
  if (cells.length === 0) return { best: null, median: 0, plateauRatio: 0, overfitRisk: true, cells: [] };

  const sorted = [...cells].sort((a, b) => b.returnPct - a.returnPct);
  const best = sorted[0]!;
  const returns = cells.map((c) => c.returnPct).sort((a, b) => a - b);
  const median = returns[Math.floor(returns.length / 2)] ?? 0;
  // 平台：与最优差距在最优的 10%（绝对值不小于 0.5%）以内
  const tol = Math.max(0.005, Math.abs(best.returnPct) * 0.1);
  const plateau = cells.filter((c) => best.returnPct - c.returnPct <= tol).length;

  const report: RobustnessReport = {
    best,
    median,
    plateauRatio: Number((plateau / cells.length).toFixed(4)),
    overfitRisk: plateau / cells.length < 0.2,
    cells,
  };
  log.info(
    "稳健性：最佳 %s/%s@%s 收益 %s，平台占比 %s%s",
    best.fast,
    best.slow,
    best.targetWeight,
    pct(best.returnPct),
    `${(report.plateauRatio * 100).toFixed(0)}%`,
    report.overfitRisk ? "（过拟合风险高）" : "",
  );
  return report;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}