/**
 * LLM 决策策略：按 decisionInterval 节流地请求 LLM 做仓位决策。
 *
 * 两个容易踩的坑（都曾真实压低对照实验里模型选手的成绩）：
 * - **决策必须持有到下一次决策**。曾经非决策根直接返回动量基线信号，
 *   模型给出的仓位活不过一根 K 线就被基线覆盖 —— 花一次模型调用只买到
 *   一根 K 线的判断，而且模型选手的成绩会退化成基线（两条曲线精确相同）。
 * - **合约模式要允许负权重**。合约是双向市场，规则策略能做空，模型却被
 *   钳在 0~1，下跌行情里天然吃亏。allowShort=true 时 prompt 与解析都放开
 *   到 −1~1（负 = 做空）。
 *
 * 回退策略：没有模型 → 纯基线；从未成功决策过 → 基线兜底；已有成功决策
 * 但本次请求失败 → 沿用上一笔判断（避免一次网络抖动把模型仓位换成另一套
 * 策略），理由标注 [llm-stale] 便于事后审计。
 */

import type { Signal } from "../core/types.js";
import { getLogger } from "../core/logger.js";
import { buildDecisionPrompt, parseDecision, type LLMClient } from "../llm/llmClient.js";
import { clamp, round } from "./momentum.js";
import type { Strategy, StrategyContext } from "./strategy.js";
import { renderNewsForPrompt, type NewsDigest } from "../news/types.js";
import { runToolAgent } from "../llm/agentLoop.js";
import type { ToolBox, ToolContext } from "../llm/tools.js";


const log = getLogger("llm-strategy");

export class LLMStrategy implements Strategy {
  readonly name = "llm-momentum";

  constructor(
    private readonly fallback: Strategy,
    private readonly llm: LLMClient | null,
    private readonly decisionInterval = 10,
    /** 新闻获取器（可选）；失败一律忽略 */
    private readonly news: (symbols: string[]) => Promise<NewsDigest[]> = async () => [],
    /** 工具箱（可选）：让模型自己查新闻/走势/当前配置 */
    private readonly tools?: ToolBox,
    private readonly toolContext?: ToolContext,
    private readonly agentMaxSteps = 0,
    /** 合约模式允许负权重（做空）；现货必须为 false */
    private readonly allowShort = false,
  ) {}

  get warmup(): number {
    return this.fallback.warmup;
  }

  /** 上一笔成功决策：非决策根沿用，模型暂时失败时也不被别的策略顶掉。 */
  private readonly held = new Map<string, Signal>();
  /** 真正发出的模型请求计数：对照实验据此发现「模型全程回退」。 */
  private readonly counter = { decisions: 0, failures: 0 };

  get stats(): { decisions: number; failures: number } {
    return { ...this.counter };
  }

  /** prompt/工具输出里给模型看的权重范围。 */
  private get weightHint(): string {
    return this.allowShort ? "-1.0~1.0" : "0.0~1.0";
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
      outputHint: `输出 JSON：{"target_weight": ${this.weightHint}, "confidence": 0.0-1.0, "reason": "不超过30字"}`,
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
    const bar = ctx.bars[ctx.bars.length - 1]!;

    // 非决策根：模型决策持有到下一次决策，绝不用基线信号把它顶掉。
    // 还没成功决策过（预热/首轮失败）才退回基线。
    if (ctx.bars.length % this.decisionInterval !== 0) {
      const held = this.held.get(ctx.symbol);
      return held ? { ...held, timestamp: bar.timestamp } : baseline;
    }
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
      allowShort: this.allowShort,
    });
    try {
      const text = await this.ask(prompt);
      const decision = parseDecision(text, { minWeight: this.allowShort ? -1 : 0 });
      this.counter.decisions += 1;
      log.info("%s LLM 决策 weight=%s conf=%s", ctx.symbol, decision.targetWeight, decision.confidence);
      const signal: Signal = {
        symbol: ctx.symbol,
        timestamp: bar.timestamp,
        targetWeight: round(clamp(decision.targetWeight, this.allowShort ? -1 : 0, 1)),
        confidence: decision.confidence,
        reason: `[llm] ${decision.reason}`,
      };
      this.held.set(ctx.symbol, signal);
      return signal;
    } catch (err) {
      this.counter.failures += 1;
      const held = this.held.get(ctx.symbol);
      if (held) {
        // 已有成功决策：一次超时/限频不该把仓位换成动量基线。
        log.warn("LLM 决策失败，沿用上一笔判断（%s）: %s", held.reason, (err as Error).message);
        return { ...held, timestamp: bar.timestamp, reason: `[llm-stale] ${held.reason}` };
      }
      log.warn("LLM 决策失败且无历史判断，回退动量基线: %s", (err as Error).message);
      return baseline ? { ...baseline, reason: `[fallback] ${baseline.reason}` } : null;
    }
  }
}
