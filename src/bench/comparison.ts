/**
 * 多模型对照（并行模拟盘 A/B）：
 *
 * 同一份行情、同一套风控、同一笔初始资金，为每个「选手」建立独立的
 * 组合与流水线，同时开跑 —— 用来横向比较哪个模型更会赚钱。
 *
 * 公平性保证：
 * - 行情只拉取一次，按全局时间顺序把同一根 K 线依次广播给所有选手；
 * - 所有选手使用相同的 risk 配置与初始资金；
 * - 每个选手拥有独立的 PortfolioManager，互不共享持仓。
 *
 * 选手类型：
 * - baseline  动量基线（不调模型，作为参照系）
 * - chat      对话模型实例（OpenAI 兼容）
 * - systemone System One 纯决策模型（Jev / Laya 等）
 */

import { mergeBarsByTime } from "../data/streaming.js";
import type { EquityPoint, Position, TradeRecord } from "../core/types.js";
import type { AppConfig, DecisionSource } from "../configSchema.js";
import { buildPipeline, feed, type Pipeline } from "../agents/orchestrator.js";
import type { ExchangeAdapter } from "../exchanges/types.js";
import type { LLMClient } from "../llm/llmClient.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("bench");

export type RunnerKind = "baseline" | "chat" | "systemone";

export interface RunnerSpec {
  /** 唯一标识：baseline 或模型实例 ID */
  id: string;
  label: string;
  kind: RunnerKind;
  model?: string;
  /** 直连客户端（对照实验不走负载均衡，保证每个模型独立决策） */
  client?: LLMClient | null;
}

export interface RunnerResult {
  id: string;
  label: string;
  kind: RunnerKind;
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
  pipeline: Pipeline;
}

export async function runComparison(
  config: AppConfig,
  options: ComparisonOptions,
): Promise<ComparisonResult> {
  const startedAt = Date.now();
  const initialCash = config.risk.initialCash;

  // 1) 行情只拉一次，所有选手共享
  const groups = await Promise.all(
    options.symbols.map((s) => options.adapter.fetchKlines(s, options.interval, options.bars)),
  );
  const bars = mergeBarsByTime(groups);
  log.info("对照实验开始：%d 个选手 × %d 根 K 线", options.runners.length, bars.length);

  // 2) 每个选手一套独立流水线（独立资金/持仓/风控）
  const contexts: RunnerCtx[] = options.runners.map((spec) => {
    // 对照实验必须单变量：每位选手只跑自己那一路，其余路不介入
    const soloSource: DecisionSource = spec.kind === "baseline" ? "rules" : spec.kind;
    const pipeline = buildPipeline(
      config,
      {
        adapter: options.adapter,
        liveTrading: options.liveTrading,
        llm: spec.kind === "chat" ? (spec.client ?? null) : null,
        soClient: spec.kind === "systemone" ? (spec.client ?? null) : null,
      },
      soloSource,
    );
    return { spec, pipeline };
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
  const { spec, pipeline } = ctx;
  const metrics = pipeline.portfolio.metrics();
  const trades = pipeline.portfolio.tradeHistory();
  const base: RunnerResult = {
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    model: spec.model,
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

/** 从 LLMManager 组装选手列表（含动量基线）。 */
export function buildRunners(input: {
  profiles: { id: string; label: string; kind: "chat" | "systemone"; model: string; enabled: boolean; hasKey: boolean }[];
  clientFor: (id: string) => { client: LLMClient; profile: { model: string } } | null;
  includeBaseline: boolean;
  includeAll?: boolean;
}): RunnerSpec[] {
  const runners: RunnerSpec[] = [];
  if (input.includeBaseline) {
    runners.push({ id: "baseline", label: "动量基线（不调模型）", kind: "baseline", client: null });
  }
  for (const p of input.profiles) {
    if (!p.enabled || !p.hasKey) continue;
    const pair = input.clientFor(p.id);
    if (!pair) continue;
    runners.push({ id: p.id, label: p.label, kind: p.kind, model: p.model, client: pair.client });
  }
  return runners;
}