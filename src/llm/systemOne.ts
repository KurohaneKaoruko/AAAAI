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
  /** 档位标签：Laya 用字符串数组；Jev 用 {档位:说明} 对象或 levels 字段 */
  criteria?: string[] | Record<string, string>;
  options?: { name: string; description?: string }[];
  levels?: string[];
}

export class SystemOneClient {
  readonly name = "systemone";
  /**
   * score 题档位标签的字段风格：
   *   - "levels"：Jev 等厂商认 questions.position.levels；
   *   - "criteria"：Laya（pydantic 严格模式）只认 criteria 字符串数组，
   *     多发一个 levels 字段都会被整单拒绝（422 extra_forbidden）。
   * 两套字段互斥、不能都发。默认按 levels 发，首次撞上 Laya 的 422 自动切换并记住，
   * 之后不再试错（一次请求内重试，调用方无感知）。
   */
  private protocol: "levels" | "criteria" = "levels";
  /**
   * 请求串行队列。本地自托管推理（单 GPU）并发吞吐差：
   * 机器人两个标的同时各发一题，服务端排队导致双双打满超时；
   * 客户端超时中止后服务端还在继续算，死任务积压又拖慢后续请求——雪球越滚越大。
   * 串行化后同一时刻只有一个请求在途，前一个完成（或失败）才发下一个。
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: SystemOneOptions) {}

  private get endpoint(): string {
    const base = this.opts.baseUrl.replace(/\/$/, "");
    return base.endsWith("/systemone") ? base : `${base}/systemone`;
  }

  /** 把一个会发 HTTP 请求的任务接进串行队列：排队等前面都结束后才执行自己。 */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // 队列尾部永远挂一个「不会 reject」的 Promise，失败不能堵死后面的请求
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 调用 System One，返回策略层可直接解析的决策 JSON。 */
  async complete(prompt: string): Promise<string> {
    return this.serialize(async () => {
      const body = {
        model: this.opts.model,
        state: this.opts.buildState(prompt),
        questions: { position: this.buildQuestion(this.protocol) },
      };
      const data = await this.request(body);
      const answer = extractAnswer(data);
      const { targetWeight, confidence, level } = parseScoreAnswer(answer, this.opts.levelWeights);
      log.debug("System One 决策 %s -> weight=%s conf=%s", level, targetWeight.toFixed(3), confidence.toFixed(3));

      // 输出策略层统一格式：JSON 字符串（LLMStrategy 用同一个解析器）
      return JSON.stringify({
        target_weight: Number(targetWeight.toFixed(4)),
        confidence: Number(confidence.toFixed(4)),
        reason: `systemone:${this.opts.model}/${level}`,
      });
    });
  }

  /**
   * 发请求；422 且错误指向档位字段时按另一套字段风格重试一次并记住。
   * Laya（criteria 数组）与 Jev（levels）的互斥字段差异对调用方完全透明。
   */
  private async request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (res.status === 422) {
      // 校验失败：如果错误信息里出现另一套字段名，说明服务端是另一种协议风格，
      // 换字段重发一次（只换一次，避免循环）。
      const text = await res.text().catch(() => "");
      const other = this.protocol === "levels" ? "criteria" : "levels";
      if (text.includes(other)) {
        log.debug("System One 服务端要求 %s 字段风格，自动切换", other);
        this.protocol = other;
        return this.request({
          ...body,
          questions: Object.fromEntries(
            Object.entries(body.questions as Record<string, unknown>).map(([k, q]) => [
              k,
              this.restyleQuestion(q as SystemOneQuestion),
            ]),
          ),
        });
      }
      throw new Error(`System One HTTP 422 ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`System One HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  /** 把题目从一种字段风格改写成另一种（重试时用）。 */
  private restyleQuestion(q: SystemOneQuestion): SystemOneQuestion {
    const levels = this.opts.levels;
    if (this.protocol === "criteria") {
      const { levels: _drop, ...rest } = q;
      return { ...rest, criteria: levels };
    }
    const { criteria: _drop, ...rest } = q;
    return { ...rest, levels };
  }

  /** 按 protocol 风格构造 score 题。 */
  private buildQuestion(protocol: "levels" | "criteria"): SystemOneQuestion {
    const levels = this.opts.levels;
    if (levels.length < 2) {
      throw new Error("System One 的 score 问题至少需要 2 个档位");
    }
    if (protocol === "criteria") {
      // Laya：criteria 必须是字符串数组，且不能带 levels 字段（pydantic extra_forbidden）
      return { type: "score", instructions: this.opts.instructions, criteria: levels };
    }
    // Jev 等：档位标签放 levels 字段
    return { type: "score", instructions: this.opts.instructions, levels };
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
    return this.serialize(async () => {
      const body = {
        model: this.opts.model,
        state: this.opts.buildState(prompt),
        questions: Object.fromEntries(
          symbols.map((symbol, i) => [`position_${i}`, this.buildQuestion(this.protocol)]),
        ),
      };
      const data = await this.request(body);
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
  // 档位名：Jev 直接给 label/level/value；Laya 只有连续 score + legend（{索引:档位名}），
  // 用 score 对照 legend 找最接近的档位，日志里才能看到模型的真实判断。
  let label = answer.label ?? answer.level ?? answer.value;
  if (label === undefined || label === null || label === "") {
    const legend = answer.legend;
    const score = numberOr(answer.score, NaN);
    if (legend && typeof legend === "object" && Number.isFinite(score)) {
      const entries = Object.entries(legend as Record<string, unknown>)
        .map(([idx, name]) => ({ idx: Number(idx), name: String(name) }))
        .filter((e) => Number.isInteger(e.idx))
        .sort((a, b) => a.idx - b.idx);
      if (entries.length > 0) {
        // score 是连续值，档位中心即其索引：四舍五入取最近档位，越界取端点
        const nearest = Math.min(Math.max(Math.round(score), 0), entries.length - 1);
        const hit = entries.find((e) => e.idx === nearest);
        if (hit) label = hit.name;
      }
    }
  }
  const level = String(label ?? "unknown");
  // 目标权重允许负数（做空档位的期望权重），由下游 RiskGuard 按交易模式裁决：
  // 现货会拒绝负目标，合约才真正做空。clamp 到 [-1,1] 防御异常概率分布。
  return { targetWeight: clamp(targetWeight, -1, 1), confidence: clamp(confidence, 0, 1), level };
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

// 决策输出由 LLMStrategy 用 llmClient 的 parseDecision 统一解析，
// 这里不再提供第二份包装（免得解析路径有两套）。