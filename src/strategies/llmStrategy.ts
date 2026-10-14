/**
 * LLM 决策策略：按 decisionInterval 节流地请求 LLM 做仓位决策，
 * 未配置 LLM / 请求失败 / 输出非法时自动回退到动量基线。
 */

import type { Signal } from "../core/types.js";
import { getLogger } from "../core/logger.js";
import { buildDecisionPrompt, parseDecision, type LLMClient } from "../llm/llmClient.js";
import { MomentumStrategy, clamp, round } from "./momentum.js";
import type { Strategy, StrategyContext } from "./strategy.js";


const log = getLogger("llm-strategy");

export class LLMStrategy implements Strategy {
  readonly name = "llm-momentum";

  constructor(
    private readonly fallback: MomentumStrategy,
    private readonly llm: LLMClient | null,
    private readonly decisionInterval = 10,
  ) {}

  get warmup(): number {
    return this.fallback.warmup;
  }

  async generate(ctx: StrategyContext): Promise<Signal | null> {
    const baseline = await this.fallback.generate(ctx);
    // 未接 LLM：纯动量运行
    if (!this.llm) return baseline;
    // 节流：每隔 N 根 K 线才真正请求一次
    if (ctx.bars.length % this.decisionInterval !== 0) return baseline;
    // 预热未完成：不调模型
    if (ctx.bars.length < this.warmup) return null;

    const prompt = buildDecisionPrompt({
      symbol: ctx.symbol,
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
      const text = await this.llm.complete(prompt);
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
