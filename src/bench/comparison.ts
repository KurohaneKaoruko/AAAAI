/**
 * 模拟对照（并行模拟盘 A/B）：
 *
 * 同一份行情、同一套风控、同一笔初始资金，为每个「选手」建立独立的
 * 组合与流水线，同时开跑 —— 用来横向比较"谁的决策更赚钱"：
 * 可以比模型，也可以比量化策略，或者直接把配置好的机器人拉进来比。
 *
 * 公平性保证：
 * - 行情只拉取一次，按全局时间顺序把同一根 K 线依次广播给所有选手；
 * - 所有选手使用相同的 risk 配置与初始资金（机器人各自的资金/风控不参与对照：
 *   那属于实盘配置，混进来就不是单变量比较了）；
 * - 每个选手可以使用**不同的策略参数**（窗口、目标权重、自主配置等），
 *   这正是"比策略"要考察的变量；
 * - 每个选手拥有独立的 PortfolioManager，互不共享持仓。
 */

import { mergeBarsByTime } from "../data/streaming.js";
import type { EquityPoint, Position, TradeRecord } from "../core/types.js";
import type { AppConfig, DecisionSource } from "../configSchema.js";
import { buildPipeline, feed, type Pipeline } from "../agents/orchestrator.js";
import type { ExchangeAdapter } from "../exchanges/types.js";
import type { LLMClient } from "../llm/llmClient.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("bench");

/** 展示分类：参照系 + 决策来源本身。 */
export type RunnerKind = "baseline" | DecisionSource;

/** 参赛者的来源，结果表里要标出来（不然"这条曲线是谁"只能靠猜）。 */
export interface RunnerOrigin {
  type: "baseline" | "strategy" | "bot" | "model";
  key: string;
  name: string;
}

export interface RunnerSpec {
  /** 唯一标识（参赛者 key：baseline / bot:… / strategy:… / model:…） */
  id: string;
  label: string;
  kind: RunnerKind;
  /** 这条选手实际使用的决策来源（对照实验里每条只跑自己那一路） */
  decisionSource: DecisionSource;
  /** 该选手的策略参数覆盖；比策略时正是靠它产生差异 */
  strategyPatch?: Record<string, unknown>;
  model?: string;
  /** 该选手实际使用的模型客户端（每类最多一个，保证单变量） */
  clients?: { chat?: LLMClient | null; systemone?: LLMClient | null };
  origin?: RunnerOrigin;
}

export interface RunnerResult {
  id: string;
  label: string;
  kind: RunnerKind;
  decisionSource: DecisionSource;
  /** 实际生效的策略参数（页面摊开给用户核对，避免"以为在跑 A 其实是 B"） */
  params: Record<string, number | boolean | string>;
  origin?: RunnerOrigin;
  model?: string;
  ok: boolean;
  error?: string;
  initialCash: number;
  finalEquity: number;
  totalReturn: number;
  maxDrawdownPct: number;
  trades: number;
  winRate: number;
  profitFactor: number;
  realizedPnl: number;
  fillCount: number;
  equityCurve: EquityPoint[];
  positions: Position[];
  llmCalls: number;
}

export interface ComparisonResult {
  symbols: string[];
  bars: number;
  initialCash: number;
  finishedAt: string;
  durationMs: number;
  winners: string[];
  results: RunnerResult[];
}

export interface ComparisonOptions {
  adapter: ExchangeAdapter;
  symbols: string[];
  bars: number;
  interval: string;
  liveTrading: boolean;
  runners: RunnerSpec[];
}

/** 单个选手的流水线 + 记账句柄（行情缓存用流水线内部那本，见下）。 */
interface RunnerCtx {
  spec: RunnerSpec;
  /** 该选手实际生效的策略段（结果里要摊开给用户核对） */
  strategy: AppConfig["strategy"];
  pipeline: Pipeline;
}

export async function runComparison(
  config: AppConfig,
  options: ComparisonOptions,
): Promise<ComparisonResult> {
  const startedAt = Date.now();
  // 统一初始资金：机器人各自的钱不参与对照，否则收益率之外还混着"谁本金大"
  const initialCash = config.risk.initialCash;

  // 1) 行情只拉一次，所有选手共享
  const groups = await Promise.all(
    options.symbols.map((s) => options.adapter.fetchKlines(s, options.interval, options.bars)),
  );
  const bars = mergeBarsByTime(groups);
  log.info("模拟对照开始：%d 个选手 × %d 根 K 线", options.runners.length, bars.length);

  // 2) 每个选手一套独立流水线（独立资金/持仓/风控）
  const contexts: RunnerCtx[] = options.runners.map((spec) => {
    // 每位选手跑自己的策略参数 + 自己的决策来源，其余路不介入（单变量）
    const strategy: AppConfig["strategy"] = {
      ...config.strategy,
      ...spec.strategyPatch,
      decisionSource: spec.decisionSource,
    };
    const pipeline = buildPipeline(
      { ...config, strategy },
      {
        adapter: options.adapter,
        liveTrading: options.liveTrading,
        llm: spec.decisionSource === "rules" || spec.decisionSource === "systemone" ? null : (spec.clients?.chat ?? null),
        soClient: spec.decisionSource === "rules" || spec.decisionSource === "chat" ? null : (spec.clients?.systemone ?? null),
      },
      spec.decisionSource,
    );
    return { spec, strategy, pipeline };
  });

  // 3) 同一根 K 线依次喂给所有选手
  for (const bar of bars) {
    for (const ctx of contexts) {
      // 必须用 pipeline.book：风控 Agent 持有的是它，
      // 若另建一本价格簿，风控会因「无行情」拒掉全部信号。
      await feed(ctx.pipeline, [bar]);
    }
  }

  // 4) 汇总各选手战绩
  const results = contexts.map((ctx) => summarize(ctx, initialCash));
  const ranked = [...results].filter((r) => r.ok).sort((a, b) => b.totalReturn - a.totalReturn);
  const result: ComparisonResult = {
    symbols: options.symbols,
    bars: bars.length,
    initialCash,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    winners: ranked.map((r) => r.id),
    results,
  };
  log.info(
    "对照实验完成：%s",
    ranked
      .slice(0, 3)
      .map((r) => `${r.label} ${(r.totalReturn * 100).toFixed(2)}%`)
      .join(" | "),
  );
  return result;
}

function summarize(ctx: RunnerCtx, initialCash: number): RunnerResult {
  const { spec, strategy, pipeline } = ctx;
  const metrics = pipeline.portfolio.metrics();
  const trades = pipeline.portfolio.tradeHistory();
  const base: RunnerResult = {
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    decisionSource: spec.decisionSource,
    params: {
      decisionSource: strategy.decisionSource,
      fastWindow: strategy.fastWindow,
      slowWindow: strategy.slowWindow,
      maxTargetWeight: strategy.maxTargetWeight,
      maxPositions: strategy.maxPositions,
      selfAllocating: strategy.selfAllocating,
    },
    ...(spec.origin ? { origin: spec.origin } : {}),
    ...(spec.model ? { model: spec.model } : {}),
    ok: true,
    initialCash,
    finalEquity: metrics.finalEquity,
    totalReturn: initialCash > 0 ? (metrics.finalEquity - initialCash) / initialCash : 0,
    maxDrawdownPct: metrics.maxDrawdownPct,
    trades: trades.length,
    winRate: 0,
    profitFactor: 0,
    realizedPnl: pipeline.portfolio.realizedPnl(),
    fillCount: metrics.totalFills,
    equityCurve: pipeline.portfolio.equityCurve(),
    positions: pipeline.portfolio.positionsSnapshot(),
    llmCalls: countLlmCalls(trades),
  };
  return { ...base, winRate: winRate(trades), profitFactor: profitFactor(trades) };
}

/** 仅卖出（含减仓）会产生已实现盈亏，用它统计胜率与盈亏比。 */
function closedTrades(trades: TradeRecord[]): TradeRecord[] {
  return trades.filter((t) => t.side === "SELL" && t.realizedPnl !== 0);
}

function winRate(trades: TradeRecord[]): number {
  const closed = closedTrades(trades);
  if (closed.length === 0) return 0;
  return closed.filter((t) => t.realizedPnl > 0).length / closed.length;
}

function profitFactor(trades: TradeRecord[]): number {
  const closed = closedTrades(trades);
  if (closed.length === 0) return 0;
  const win = closed.filter((t) => t.realizedPnl > 0).reduce((s, t) => s + t.realizedPnl, 0);
  const loss = Math.abs(closed.filter((t) => t.realizedPnl < 0).reduce((s, t) => s + t.realizedPnl, 0));
  if (loss === 0) return win > 0 ? Number.POSITIVE_INFINITY : 0;
  return win / loss;
}

/** 模型调用次数：决策类成交数近似（对照实验里用于判断选手是否真的在用模型）。 */
function countLlmCalls(trades: TradeRecord[]): number {
  return trades.filter((t) => t.reason?.includes("llm") || t.reason?.includes("systemone")).length;
}