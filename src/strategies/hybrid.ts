/**
 * 混合决策的执行体：大模型分析行情 -> 决策模型做决策。
 *
 * 两步职责严格分离：
 *   1) 分析：对话模型只看行情，输出「怎么看」（强弱/理由/排序），**不给仓位**；
 *   2) 决策：System One 拿到分析结论作为 state，逐标的定档位，档位概率换算成仓位。
 *
 * 降级链（任一环挂掉都不会让组合停摆）：
 *   决策模型挂 + 分析可用 -> 直接把「强弱」按档位换算成权重（记明来源）；
 *   分析挂 + 决策模型可用 -> 决策模型在「无分析」状态下独立决策（influence 自动按 0 处理）；
 *   两边都挂            -> 横截面动量基线。
 */

import { getLogger } from "../core/logger.js";
import {
  analysisToWeights,
  buildAnalysisPrompt,
  fallbackAnalysis,
  parseAnalysis,
  renderAnalysisForState,
  STRENGTH_ZH,
  type MarketAnalysis,
} from "../llm/hybrid.js";
import { normalizeAllocation, type AllocationLimits, type AssetSnapshot } from "../llm/allocation.js";
import { parseDecision, type LLMClient } from "../llm/llmClient.js";
import { renderNewsForPrompt, type NewsDigest } from "../news/types.js";
import { runToolAgent } from "../llm/agentLoop.js";
import type { ToolBox, ToolContext } from "../llm/tools.js";
import type { AllocationResult } from "./allocator.js";
import { CrossSectionalAllocator } from "./allocator.js";

const log = getLogger("hybrid");

export interface HybridOptions {
  /** 分析影响力（0~1）：0 = 决策模型看不到分析 */
  influence: number;
  /** 分析结论有效期（毫秒）：期内同一批候选不重复调用大模型 */
  analysisTtlMs: number;
  /** 分析调用超时（毫秒） */
  timeoutMs: number;
  /** 新闻获取器：给标的返回新闻摘要；没有新闻源时省略 */
  news?: (symbols: string[]) => Promise<NewsDigest[]>;
  /** 工具箱：大模型可以自己查新闻/走势/当前配置 */
  tools?: ToolBox;
  toolContext?: ToolContext;
  /** 单次决策允许的工具调用轮数（0 = 不用工具） */
  agentMaxSteps?: number;
}

/** 行情分析器：带 TTL 缓存与动量兜底。 */
export class HybridAnalyst {
  private cached: { at: number; key: string; analysis: MarketAnalysis } | null = null;
  /** 最近一次分析用到的工具（写进日志与理由，便于审计模型查了什么） */
  lastAudit = "";

  constructor(
    private readonly chat: LLMClient | null,
    private readonly opts: HybridOptions,
  ) {}

  /**
   * 向大模型要「分析」。
   * 配了工具箱就让模型自己查（新闻、走势、当前配置…），否则退回一次性 prompt。
   */
  private async ask(snapshots: AssetSnapshot[], news: NewsDigest[]): Promise<string> {
    const base = buildAnalysisPrompt(snapshots, news);
    const steps = this.opts.agentMaxSteps ?? 0;
    if (!this.opts.tools || !this.opts.toolContext || steps <= 0) {
      return withTimeout(this.chat!.complete(base), this.opts.timeoutMs);
    }
    const run = await runToolAgent({
      client: this.chat!,
      tools: this.opts.tools,
      context: this.opts.toolContext,
      instruction:
        "你是一名量化研究员，需要先自己查清事实，再给出技术面分析。你只能做查询，不能下单，也不能修改任何参数。" +
        "缺什么就用什么工具去查（例如不确定近况就 search_news，想确认走势就 get_history，想知道现在仓位就 get_allocation）。",
      task: base,
      outputHint:
        "请输出 JSON（不要输出其他文字）：" +
        '{"summary":"不超过60字的整体判断","views":[{"symbol":"标的","view":"一句话技术面判断","strength":"strong|moderate|weak","confidence":0.0-1.0}],"ranking":["从强到弱的标的顺序"]}',
      maxSteps: steps,
      timeoutMs: this.opts.timeoutMs,
    });
    this.lastAudit = run.audit;
    return run.text;
  }

  /** 新闻是可选输入：拿不到就当没有，绝不因新闻失败影响分析。 */
  private async loadNews(snapshots: AssetSnapshot[]): Promise<NewsDigest[]> {
    if (!this.opts.news) return [];
    try {
      return await this.opts.news(snapshots.map((s) => s.symbol));
    } catch (err) {
      log.warn("取新闻失败，本次分析不带新闻: %s", (err as Error).message);
      return [];
    }
  }

  /** 分析候选池。模型不可用时返回动量兜底分析（source=rules）。 */
  async analyze(snapshots: AssetSnapshot[], force = false): Promise<MarketAnalysis> {
    if (snapshots.length === 0) return fallbackAnalysis([]);
    const key = snapshots.map((s) => `${s.symbol}:${s.price.toFixed(4)}:${s.momentum.toFixed(4)}`).join("|");
    const now = Date.now();
    if (!force && this.cached && this.cached.key === key && now - this.cached.at <= this.opts.analysisTtlMs) {
      return this.cached.analysis;
    }

    if (!this.chat) {
      const analysis = fallbackAnalysis(snapshots);
      this.cached = { at: now, key, analysis };
      return analysis;
    }

    try {
      const news = await this.loadNews(snapshots);
      const text = await this.ask(snapshots, news);
      const analysis = parseAnalysis(text, snapshots.map((s) => s.symbol));
      this.cached = { at: now, key, analysis };
      log.info("大模型分析：%s（排序 %s%s）", analysis.summary, analysis.ranking.join(">"), this.lastAudit ? `｜工具：${this.lastAudit}` : "");
      return analysis;
    } catch (err) {
      const analysis = fallbackAnalysis(snapshots);
      this.cached = { at: now, key, analysis };
      log.warn("行情分析失败（%s），改用动量兜底", (err as Error).message);
      return analysis;
    }
  }
}

/** 逐标的的决策结果（档位 + 权重）。 */
export interface SymbolDecision {
  symbol: string;
  weight: number;
  confidence: number;
  level: string;
  reason: string;
}

/**
 * 决策端：把分析结论交给 System One，由它逐标的定档位。
 * 传入 symbols 全部标的，一次拿到各自的仓位。
 */
export async function decideWithSystemOne(
  client: LLMClient | null,
  snapshots: AssetSnapshot[],
  analysis: MarketAnalysis,
  opts: HybridOptions,
): Promise<{ decisions: SymbolDecision[]; note: string }> {
  const symbols = snapshots.map((s) => s.symbol);
  if (!client) {
    // 决策模型不可用：直接把分析的「强弱」换算成权重
    const weights = analysisToWeights(analysis, symbols);
    const decisions = symbols.map((s) => ({
      symbol: s,
      weight: weights[s] ?? 0,
      confidence: 0.5,
      level: analysis.views.find((v) => v.symbol === s)?.strength ?? "weak",
      reason: "决策模型不可用，按大模型分析的强弱档换算",
    }));
    return { decisions, note: "决策模型不可用，已按大模型分析的强弱换算仓位" };
  }

  // 没有真实分析（或影响力为 0）时，决策模型独立决策
  const influence = analysis.source === "ai" ? clamp01(opts.influence) : 0;
  const news = await loadNewsQuietly(opts, symbols);
  const state = renderAnalysisForState(analysis, symbols, influence) + renderNewsForPrompt(news);

  if (!client.allocate) {
    // 决策端不具备多标的提问能力：退化成按强弱换算（等同决策模型不可用）
    const weights = analysisToWeights(analysis, symbols);
    return {
      decisions: symbols.map((s) => ({
        symbol: s,
        weight: weights[s] ?? 0,
        confidence: 0.5,
        level: analysis.views.find((v) => v.symbol === s)?.strength ?? "weak",
        reason: "决策端不支持多标的提问，按分析强弱换算",
      })),
      note: "决策端未实现多标的提问，已按分析强弱换算",
    };
  }
  const json = await client.allocate(buildDecisionState(snapshots, state), symbols);
  const raw = JSON.parse(json) as Record<string, unknown>;
  const allocations = (raw.allocations ?? {}) as Record<string, number>;
  const decisions: SymbolDecision[] = symbols.map((s) => {
    const weight = Number(allocations[s] ?? 0);
    return {
      symbol: s,
      weight: Number.isFinite(weight) ? clamp01(weight) : 0,
      confidence: 0.5,
      level: "-",
      reason: "System One 档位",
    };
  });
  return {
    decisions,
    note:
      influence === 0
        ? "分析未生效（无分析结论或影响力为 0），决策模型独立决策"
        : `已注入大模型分析（影响力 ${(influence * 100).toFixed(0)}%）`,
  };
}

/** 单标的决策（逐标的模式下用）：System One 只看一个标的，但 state 里同样带分析。 */
export async function decideSingle(
  client: LLMClient | null,
  snapshot: AssetSnapshot,
  analysis: MarketAnalysis,
  opts: HybridOptions,
): Promise<SymbolDecision> {
  if (!client) {
    const weights = analysisToWeights(analysis, [snapshot.symbol]);
    return {
      symbol: snapshot.symbol,
      weight: weights[snapshot.symbol] ?? 0,
      confidence: 0.5,
      level: analysis.views.find((v) => v.symbol === snapshot.symbol)?.strength ?? "weak",
      reason: "决策模型不可用，按大模型分析的强弱档换算",
    };
  }
  const influence = analysis.source === "ai" ? clamp01(opts.influence) : 0;
  const state = renderAnalysisForState(analysis, [snapshot.symbol], influence);
  const prompt = [
    `标的：${snapshot.symbol}`,
    `最新价=${snapshot.price} 5期=${(snapshot.retShort * 100).toFixed(2)}% 20期=${(snapshot.retLong * 100).toFixed(2)}% 动量=${snapshot.momentum.toFixed(4)} 趋势=${snapshot.trend}`,
    state,
    "",
    `请给 ${snapshot.symbol} 定一个仓位档位。`,
    '{"target_weight": 0.0-1.0, "confidence": 0.0-1.0, "reason": "不超过30字"}',
  ].join("\n");
  const decision = parseDecision(await client.complete(prompt));
  const level = /档位=([\w-]+)/.exec(decision.reason)?.[1] ?? decision.reason;
  return {
    symbol: snapshot.symbol,
    weight: decision.targetWeight,
    confidence: decision.confidence,
    level,
    reason: decision.reason,
  };
}

/**
 * 资产配置模式下的混合决策器。
 * 实现与 AIAllocator 相同接口，可直接塞进 AllocatorAgent。
 */
export class HybridAllocator {
  constructor(
    private readonly analyst: HybridAnalyst,
    private readonly decider: LLMClient | null,
    private readonly baseline: CrossSectionalAllocator,
    private readonly limits: AllocationLimits,
    private readonly opts: HybridOptions,
  ) {}

  async allocate(snapshots: AssetSnapshot[]): Promise<AllocationResult> {
    if (snapshots.length === 0) {
      return { weights: {}, cashWeight: 1, confidence: 0, reason: "无候选资产", source: "rules", notes: [] };
    }
    const symbols = snapshots.map((s) => s.symbol);
    const analysis = await this.analyst.analyze(snapshots);

    let decisions: SymbolDecision[];
    let note: string;
    try {
      const r = await decideWithSystemOne(this.decider, snapshots, analysis, this.opts);
      decisions = r.decisions;
      note = r.note;
    } catch (err) {
      // 决策模型调用失败：整轮回退动量基线，不做半吊子配置
      const base = await this.baseline.allocate(snapshots);
      return {
        ...base,
        notes: [`决策模型调用失败（${(err as Error).message}），整轮回退横截面动量`],
      };
    }

    const raw: Record<string, number> = {};
    for (const d of decisions) {
      if (d.weight > 0) raw[d.symbol] = d.weight;
    }
    const normalized = normalizeAllocation(
      { weights: raw, cashWeight: 0, confidence: 0, reason: "" },
      symbols,
      this.limits,
    );
    const confidence =
      decisions.reduce((acc, d) => acc + d.confidence * d.weight, 0) /
      Math.max(1e-9, decisions.reduce((acc, d) => acc + d.weight, 0));

    const top = normalized.weights
      ? Object.entries(normalized.weights)
          .sort((a, b) => b[1] - a[1])[0]
      : undefined;
    log.info(
      "混合决策 %s（分析：%s）",
      top ? `${top[0]} ${(top[1] * 100).toFixed(0)}%` : "空仓",
      analysis.summary || "-",
    );

    return {
      weights: normalized.weights,
      cashWeight: normalized.cashWeight,
      confidence: Number(confidence.toFixed(4)),
      reason: analysis.summary || note,
      source: analysis.source === "ai" ? "hybrid" : "rules",
      notes: [note, ...normalized.notes],
    };
  }
}

/** 取新闻摘要（失败静默）。 */
async function loadNewsQuietly(opts: HybridOptions, symbols: string[]): Promise<NewsDigest[]> {
  if (!opts.news) return [];
  try {
    return await opts.news(symbols);
  } catch {
    return [];
  }
}

/** 构造给 System One 的 state：技术面摘要 + 分析结论。 */
function buildDecisionState(snapshots: AssetSnapshot[], analysisText: string): string {
  const rows = snapshots
    .map((s) => `${s.symbol} 价=${s.price} 5期=${(s.retShort * 100).toFixed(2)}% 20期=${(s.retLong * 100).toFixed(2)}% 动量=${s.momentum.toFixed(4)} 趋势=${s.trend}`)
    .join("\n");
  return [`【候选资产技术面】`, rows, analysisText].join("\n");
}

function clamp01(v: number): number {
  return Math.min(Math.max(v, 0), 1);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return p;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`分析超时 ${ms}ms`)), ms)),
  ]);
}

export { STRENGTH_ZH };