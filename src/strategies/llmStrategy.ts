/**
 * LLM 决策策略：按 decisionInterval 节流地请求 LLM 做仓位决策，
 * 未配置 LLM / 请求失败 / 输出非法时自动回退到动量基线。
 */

import type { Signal } from "../core/types.js";
import { getLogger } from "../core/logger.js";
import { buildDecisionPrompt, parseDecision, type LLMClient } from "../llm/llmClient.js";
import { MomentumStrategy, clamp, round } from "./momentum.js";
import type { Strategy, StrategyContext } from "./strategy.js";
import { renderNewsForPrompt, type NewsDigest } from "../news/types.js";
import { runToolAgent } from "../llm/agentLoop.js";
import type { ToolBox, ToolContext } from "../llm/tools.js";


const log = getLogger("llm-strategy");

export class LLMStrategy implements Strategy {
  readonly name = "llm-momentum";

  constructor(
    private readonly fallback: MomentumStrategy,
    private readonly llm: LLMClient | null,
    private readonly decisionInterval = 10,
    /** 新闻获取器（可选）；失败一律忽略 */
    private readonly news: (symbols: string[]) => Promise<NewsDigest[]> = async () => [],
    /** 工具箱（可选）：让模型自己查新闻/走势/当前配置 */
    private readonly tools?: ToolBox,
    private readonly toolContext?: ToolContext,
    private readonly agentMaxSteps = 0,
  ) {}

  get warmup(): number {
    return this.fallback.warmup;
  }

  /** 配了工具箱就让模型自己查；否则一次性给完整 prompt。 */
  private async ask(prompt: string): Promise<string> {
    if (!this.tools || !this.toolContext || this.agentMaxSteps <= 0) {
      return this.llm!.complete(prompt);
    }
    const run = await runToolAgent({
      client: this.llm!,
      tools: this.tools,
      context: this.toolContext,
      instruction:
        "你是交易员。输出仓位前如果缺信息（近况、走势、现在持有什么），先用工具查；只读，不能下单。",
      task: prompt,
      outputHint: '输出 JSON：{"target_weight": 0.0-1.0, "confidence": 0.0-1.0, "reason": "不超过30字"}',
      maxSteps: this.agentMaxSteps,
    });
    if (run.audit) log.debug("%s 决策前查询：%s", this.lastSymbol, run.audit);
    return run.text;
  }

  private lastSymbol = "";

  private async newsFor(symbol: string): Promise<NewsDigest[]> {
    try {
      return await this.news([symbol]);
    } catch {
      return [];
    }
  }

  async generate(ctx: StrategyContext): Promise<Signal | null> {
    const baseline = await this.fallback.generate(ctx);
    // 新闻拿不到就当没有，绝不因为新闻失败而中断决策
    // 未接 LLM：纯动量运行
    if (!this.llm) return baseline;
    // 节流：每隔 N 根 K 线才真正请求一次
    if (ctx.bars.length % this.decisionInterval !== 0) return baseline;
    // 预热未完成：不调模型
    if (ctx.bars.length < this.warmup) return null;

    this.lastSymbol = ctx.symbol;
    const news = await this.newsFor(ctx.symbol);
    const prompt = buildDecisionPrompt({
      symbol: ctx.symbol,
      news: renderNewsForPrompt(news),
      bars: ctx.bars.map((b) => ({
        timestamp: b.timestamp.toISOString(),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
      view: ctx.view,
    });
    try {
      const text = await this.ask(prompt);
      const decision = parseDecision(text);
      log.info("%s LLM 决策 weight=%s conf=%s", ctx.symbol, decision.targetWeight, decision.confidence);
      return {
        symbol: ctx.symbol,
        timestamp: ctx.bars[ctx.bars.length - 1]!.timestamp,
        targetWeight: round(clamp(decision.targetWeight, 0, 1)),
        confidence: decision.confidence,
        reason: `[llm] ${decision.reason}`,
      };
    } catch (err) {
      log.warn("LLM 决策失败，回退动量基线: %s", (err as Error).message);
      return baseline ? { ...baseline, reason: `[fallback] ${baseline.reason}` } : null;
    }
  }
}
