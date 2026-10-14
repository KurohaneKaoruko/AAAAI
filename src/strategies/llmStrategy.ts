/**
 * LLM 决策策略：按 decisionInterval 节流地请求 LLM 做仓位决策，
 * 未配置 LLM / 请求失败 / 输出非法时自动回退到动量基线。
 */

import type { Signal } from "../core/types.js";
import { getLogger } from "../core/logger.js";
import { buildDecisionPrompt, parseDecision, type LLMClient } from "../llm/llmClient.js";
import { MomentumStrategy, clamp, round } from "./momentum.js";
import type { Strategy, StrategyContext } from "./strategy.js";
import type { DecisionSource } from "../configSchema.js";
import type { JointBoard } from "../llm/jointBoard.js";

/** 支持共享「联合决策板」的策略（用于两路模型互相参考结论）。 */
export interface BoardAware {
  setBoard(board: JointBoard, source: DecisionSource): void;
}

const log = getLogger("llm-strategy");

export class LLMStrategy implements Strategy {
  readonly name = "llm-momentum";

  private board: JointBoard | null = null;
  private source: DecisionSource = "chat";

  constructor(
    private readonly fallback: MomentumStrategy,
    private readonly llm: LLMClient | null,
    private readonly decisionInterval = 10,
    board?: JointBoard | null,
    source: DecisionSource = "chat",
  ) {
    if (board) this.setBoard(board, source);
  }

  /** 接入联合决策板：prompt 里会带上另一路的判断，自己的结论也写回黑板。 */
  setBoard(board: JointBoard, source: DecisionSource): void {
    this.board = board;
    this.source = source;
  }

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
      board: this.board ?? undefined,
      source: this.board ? this.source : undefined,
    });
    try {
      const text = await this.llm.complete(prompt);
      const decision = parseDecision(text);
      log.info("%s LLM 决策 weight=%s conf=%s", ctx.symbol, decision.targetWeight, decision.confidence);
      if (this.board) {
        this.board.set(this.source, {
          note: decision.reason,
          perSymbol: { [ctx.symbol]: `${(decision.targetWeight * 100).toFixed(0)}%` },
        });
      }
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
