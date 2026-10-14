/**
 * System One 决策模型客户端（Jev / Laya / 阿里云百炼等）。
 *
 * 与对话模型的根本区别：**没有 /chat/completions**。
 * 协议为 POST {baseUrl}/v1/systemone：
 *
 *   请求 { model, state, questions: { <id>: { type: "score"|"choice"|"noul", instructions, ... } } }
 *   响应 { answers: { <id>: { value/label, probabilities, confidence } }, usage, elapsedMs }
 *
 * 本文件把「带概率的类型化答案」换算成策略层认识的决策 JSON：
 *   target_weight = Σ P(级别) × 该级别权重
 *   confidence    = 模型的 confidence（缺失时用 1 - 熵 近似）
 *
 * 注意：不同厂商的响应字段略有差异（value/label/level、probabilities 为对象或数组），
 * 因此解析器采用宽松匹配；如遇新厂商，按 parseScoreAnswer() 补一个分支即可。
 */

import { getLogger } from "../core/logger.js";
import { parseDecision } from "./llmClient.js";

const log = getLogger("llm:systemone");

export interface SystemOneOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** 档位标签，从低到高，例如 ["flat","weak","moderate","strong"] */
  levels: string[];
  /** 每个档位对应的目标仓位权重（与 levels 等长，0~1） */
  levelWeights: number[];
  /** 提问内容 */
  instructions: string;
  /** state 构造方式：把 K 线序列拼成文本 */
  buildState: (prompt: string) => string;
}

/** System One 协议常见问题类型。 */
export type SystemOneQuestionType = "score" | "choice" | "noul";

export interface SystemOneQuestion {
  type: SystemOneQuestionType;
  instructions: string;
  criteria?: Record<string, string>;
  options?: { name: string; description?: string }[];
  levels?: string[];
}

export class SystemOneClient {
  readonly name = "systemone";

  constructor(private readonly opts: SystemOneOptions) {}

  private get endpoint(): string {
    const base = this.opts.baseUrl.replace(/\/$/, "");
    return base.endsWith("/systemone") ? base : `${base}/systemone`;
  }

  /** 调用 System One，返回策略层可直接解析的决策 JSON。 */
  async complete(prompt: string): Promise<string> {
    const question = this.buildQuestion();
    const body = {
      model: this.opts.model,
      state: this.opts.buildState(prompt),
      questions: { position: question },
    };

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`System One HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const answer = extractAnswer(data);
    const { targetWeight, confidence, level } = parseScoreAnswer(answer, this.opts.levelWeights);
    log.debug("System One 决策 %s -> weight=%s conf=%s", level, targetWeight.toFixed(3), confidence.toFixed(3));

    // 输出策略层统一格式：JSON 字符串（LLMStrategy 用同一个解析器）
    return JSON.stringify({
      target_weight: Number(targetWeight.toFixed(4)),
      confidence: Number(confidence.toFixed(4)),
      reason: `systemone:${this.opts.model}/${level}`,
    });
  }

  private buildQuestion(): SystemOneQuestion {
    const levels = this.opts.levels;
    if (levels.length < 2) {
      throw new Error("System One 的 score 问题至少需要 2 个档位");
    }
    return {
      type: "score",
      instructions: this.opts.instructions,
      levels,
    };
  }

  /**
   * 资产配置：一个请求里对每个标的各问一道 score 题，
   * 用各标的档位概率的期望权重拼成组合配置。
   * System One 没有 chat 接口，这是它表达「买哪些、各占多少」的方式。
   */
  async allocate(prompt: string, symbols: string[]): Promise<string> {
    if (symbols.length === 0) {
      return JSON.stringify({ allocations: {}, cash_weight: 1, confidence: 0, reason: "无候选资产" });
    }
    const body = {
      model: this.opts.model,
      state: this.opts.buildState(prompt),
      questions: Object.fromEntries(
        symbols.map((symbol, i) => [`position_${i}`, this.buildQuestion()]),
      ),
    };
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`System One HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const answers = (data.answers ?? data) as Record<string, unknown>;
    const allocations: Record<string, number> = {};
    let confSum = 0;
    let picked = 0;
    symbols.forEach((symbol, i) => {
      const answer = answers[`position_${i}`];
      if (!answer || typeof answer !== "object") return;
      const { targetWeight, confidence, level } = parseScoreAnswer(
        answer as Record<string, unknown>,
        this.opts.levelWeights,
      );
      allocations[symbol] = Number(targetWeight.toFixed(4));
      confSum += confidence;
      picked += 1;
      log.debug("System One 配置 %s -> %s (%s)", symbol, level, targetWeight.toFixed(3));
    });
    if (picked === 0) throw new Error("System One 响应中找不到任何标的的答案");
    return JSON.stringify({
      allocations,
      cash_weight: 0,
      confidence: Number((confSum / picked).toFixed(4)),
      reason: `systemone:${this.opts.model}/${symbols.length}标的`,
    });
  }
}

/** 兼容多种响应外壳，取出第一个问题的答案对象。 */
export function extractAnswer(data: Record<string, unknown>): Record<string, unknown> {
  const candidates = [data.answers, data.answer, data.results, data.questions, data];
  for (const c of candidates) {
    if (c && typeof c === "object") {
      const obj = c as Record<string, unknown>;
      if (obj.position && typeof obj.position === "object") return obj.position as Record<string, unknown>;
      // 只有一个键时直接取它
      const values = Object.values(obj);
      if (values.length === 1 && typeof values[0] === "object" && values[0] !== null) {
        return values[0] as Record<string, unknown>;
      }
    }
  }
  throw new Error(`System One 响应中找不到答案字段: ${JSON.stringify(data).slice(0, 200)}`);
}

/**
 * 把类型化答案换算为目标仓位。
 * 权重 = Σ P(档位) × 档位权重；置信度取模型 confidence，缺失时用 1 - 归一化熵 近似。
 */
export function parseScoreAnswer(
  answer: Record<string, unknown>,
  levelWeights: number[],
): { targetWeight: number; confidence: number; level: string } {
  const probabilities = extractProbabilities(answer);
  let targetWeight = 0;
  let total = 0;
  probabilities.forEach((p, i) => {
    const w = levelWeights[i] ?? 0;
    targetWeight += p * w;
    total += p;
  });
  if (total > 0) targetWeight /= total; // 概率未归一化时归一化
  else {
    // 没有概率分布：退化用选中的档位权重
    const idx = indexOfLevel(answer);
    targetWeight = idx >= 0 ? (levelWeights[idx] ?? 0) : 0;
  }

  let confidence = numberOr(answer.confidence, NaN);
  if (!Number.isFinite(confidence)) {
    confidence = probabilities.length > 0 ? 1 - normalizedEntropy(probabilities) : 0.5;
  }
  const label = String(answer.label ?? answer.level ?? answer.value ?? "unknown");
  return { targetWeight: clamp(targetWeight, 0, 1), confidence: clamp(confidence, 0, 1), level: label };
}

/** 概率分布：对象 {level:p} 或数组 [p...]，兼容 value/label 字段名。 */
export function extractProbabilities(answer: Record<string, unknown>): number[] {
  const raw = answer.probabilities ?? answer.probs ?? answer.distribution;
  if (Array.isArray(raw)) return raw.map((v) => Number(v) || 0);
  if (raw && typeof raw === "object") {
    return Object.values(raw as Record<string, unknown>).map((v) => Number(v) || 0);
  }
  return [];
}

function indexOfLevel(answer: Record<string, unknown>): number {
  const v = answer.value ?? answer.label ?? answer.level;
  if (typeof v === "number") return v;
  if (typeof v === "string") return -1;
  return -1;
}

function normalizedEntropy(probs: number[]): number {
  const total = probs.reduce((a, b) => a + b, 0);
  if (total <= 0) return 1;
  let h = 0;
  for (const p of probs) {
    const q = p / total;
    if (q > 0) h -= q * Math.log(q);
  }
  return h / Math.log(probs.length || 2);
}

function numberOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** 从决策 prompt 中还原出 state 文本（System One 只吃文本/JSON）。 */
export function buildStateFromPrompt(prompt: string): string {
  // 决策 prompt 结构固定：剔除指令段落，只保留行情部分
  const marker = prompt.indexOf("最近 K 线");
  if (marker < 0) return prompt;
  const header = prompt.slice(0, prompt.indexOf("\n\n"));
  return `${header}\n\n${prompt.slice(marker)}`;
}

/** 校验 System One 决策输出（复用通用解析器，便于统一测试）。 */
export function parseSystemOneDecision(text: string) {
  return parseDecision(text);
}