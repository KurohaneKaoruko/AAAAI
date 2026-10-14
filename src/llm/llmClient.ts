/** LLM 客户端抽象：策略与分析的"大脑"接入点。 */

import type { DecisionSource } from "../configSchema.js";
import type { JointBoard } from "./jointBoard.js";

export interface LLMClient {
  readonly name: string;
  /** 发送 prompt，返回模型文本输出。 */
  complete(prompt: string): Promise<string>;
  /**
   * 资产配置能力：一次决定「买哪些、各占多少」。
   *
   * 对话模型默认等价于 complete（prompt 里已要求输出 allocations JSON）；
   * System One 这类纯决策模型没有 chat 接口，需要按协议另行实现。
   * 未实现时上层自动回退到横截面动量基线，不会中断运行。
   */
  allocate?(prompt: string, symbols: string[]): Promise<string>;
}

/** 交易决策的 LLM 输出结构。 */
export interface LLMDecision {
  targetWeight: number;
  confidence: number;
  reason: string;
}

/** 构造交易决策 Prompt：只给概要行情，不给未来信息。 */
export function buildDecisionPrompt(args: {
  symbol: string;
  bars: { timestamp: string; open: number; high: number; low: number; close: number }[];
  view?: { trend: string; momentum: number };
  /** 联合决策板：把另一路模型的判断带进来，实现「一起决策」 */
  board?: JointBoard;
  /** 当前这一路（用于在黑板里排除自己） */
  source?: DecisionSource;
}): string {
  const recent = args.bars.slice(-20);
  const lines = recent
    .map(
      (b) =>
        `${b.timestamp} O=${b.open} H=${b.high} L=${b.low} C=${b.close}`,
    )
    .join("\n");
  const view = args.view
    ? `当前市场解读: 趋势=${args.view.trend}, 动量=${args.view.momentum.toFixed(4)}`
    : "当前市场解读: 无";
  const others = args.board && args.source ? args.board.renderOthers(args.source) : "";
  return [
    `你是一名严谨的量化交易员，正在为 ${args.symbol} 做仓位决策。`,
    view,
    others,
    "最近 K 线（由旧到新）:",
    lines,
    "",
    "请基于以上信息，输出一个 JSON 对象（不要输出任何其他文字）:",
    '{"target_weight": 0.0-1.0, "confidence": 0.0-1.0, "reason": "不超过50字的决策理由"}',
    "约束:",
    "- target_weight 是目标仓位占总权益的比例，0 表示空仓；",
    "- 信息不足或市场方向不明时，target_weight 应为 0；",
    "- 只做什么都不做，不要虚构未提供的数据。",
  ].join("\n");
}

/** 解析 LLM 的 JSON 决策输出；容忍 ```json 围栏与前后杂文本。 */
export function parseDecision(text: string): LLMDecision {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("LLM 输出中未找到 JSON 对象");
  const raw = JSON.parse(match[0]) as Record<string, unknown>;
  const targetWeight = Number(raw.target_weight ?? raw.targetWeight);
  const confidence = Number(raw.confidence ?? 0);
  const reason = String(raw.reason ?? "").slice(0, 120);
  if (!Number.isFinite(targetWeight) || targetWeight < 0 || targetWeight > 1) {
    throw new Error(`LLM 输出 target_weight 非法: ${String(raw.target_weight)}`);
  }
  return {
    targetWeight,
    confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0,
    reason: reason || "llm-decision",
  };
}
