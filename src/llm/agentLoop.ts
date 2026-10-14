/**
 * 工具调用循环：让大模型自己决定要查什么、查完再给结论。
 *
 * 两条协议，按客户端能力自动选择：
 * - 原生 function calling：客户端实现了 chat() 且模型支持 tools 时使用；
 * - 文本协议：任何模型都能用 —— 让模型输出 {"tool":"...","args":{...}}，
 *   我们执行后把结果贴回去继续对话（弱模型/国产模型/不支持 tools 的端点靠这条路）。
 *
 * 三道保险：
 * - 轮数上限（maxSteps），工具再好用也不能无限转圈；
 * - 单轮超时；
 * - 只读工具箱，模型没有任何下单能力。
 */

import { getLogger } from "../core/logger.js";
import type { ToolBox, ToolContext, ToolSpec } from "./tools.js";
import type { LLMClient } from "./llmClient.js";

const log = getLogger("agent:tools");

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

export interface AgentStep {
  tool: string;
  args: unknown;
  ok: boolean;
  /** 结果摘要（写进决策理由，便于审计模型到底查了什么） */
  brief: string;
  error?: string;
}

export interface AgentRun {
  /** 模型的最终文字输出 */
  text: string;
  steps: AgentStep[];
  /** 人类可读的审计串，例如 "news(600519)→5条 · history(BTC,60)→-2.1%" */
  audit: string;
}

export interface AgentOptions {
  client: LLMClient;
  tools: ToolBox;
  context: ToolContext;
  /** 任务说明（会作为 system 消息） */
  instruction: string;
  /** 首轮用户消息 */
  task: string;
  /** 最终输出要求，会追加到 task 末尾 */
  outputHint: string;
  maxSteps?: number;
  timeoutMs?: number;
}

/** 跑一轮「模型 + 工具」协作，直到模型给出不带工具调用的最终回答。 */
export async function runToolAgent(opts: AgentOptions): Promise<AgentRun> {
  const maxSteps = Math.max(0, Math.min(12, opts.maxSteps ?? 4));
  const specs = opts.tools.list();
  const steps: AgentStep[] = [];
  if (maxSteps === 0 || specs.length === 0) {
    return { text: await opts.client.complete(`${opts.task}\n\n${opts.outputHint}`), steps, audit: "" };
  }

  const system = [
    opts.instruction,
    "",
    "你可以使用下面这些只读工具，按需调用；查够了就直接给结论，不要空转：",
    ...specs.map((s) => `- ${s.name}：${s.description}\n  调用示例：${s.example}`),
    "",
    "如果你要用文本方式调用工具，就只输出一行 JSON，形如：",
    '{"tool":"search_news","args":{"symbol":"600519","limit":5}}',
    "一次只调一个工具。收到结果后（以 [工具结果] 开头）再决定下一步。",
    "查完请直接输出最终答案，不要再输出工具调用行。",
  ].join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: `${opts.task}\n\n${opts.outputHint}` },
  ];

  let text = "";
  for (let i = 0; i < maxSteps; i++) {
    const reply = await callWithTimeout(
      // 优先原生 tools；客户端不支持就走文本协议
      opts.client.chat
        ? opts.client.chat(messages, specs)
        : Promise.resolve(opts.client.complete(dumpMessages(messages))).then(async (content) => ({
            content,
            toolCalls: parseToolCallFromText(content),
          })),
      opts.timeoutMs ?? 60_000,
    );

    const call = reply.toolCalls?.[0];
    if (!call) {
      text = reply.content;
      break;
    }

    const result = await opts.tools.invoke(call.name, call.args, opts.context);
    const step: AgentStep = {
      tool: call.name,
      args: call.args,
      ok: result.ok,
      brief: briefOf(call.name, result),
      error: result.error,
    };
    steps.push(step);
    log.debug("模型调用工具 %s %s -> %s", call.name, JSON.stringify(call.args ?? {}).slice(0, 80), step.brief);

    messages.push({ role: "assistant", content: reply.content || `调用 ${call.name}` });
    messages.push({
      role: "tool",
      name: call.name,
      content: result.ok ? JSON.stringify(result.data).slice(0, 4000) : `调用失败：${result.error}`,
    });

    if (i === maxSteps - 1) {
      // 预算用尽：让它基于已有信息收尾
      messages.push({ role: "user", content: "工具调用次数已用完，请直接基于现有信息给出最终答案。" });
      text = await opts.client.complete(dumpMessages(messages));
    }
  }

  return { text, steps, audit: steps.map((s) => `${s.tool}->${s.brief}`).join(" · ") };
}

/**
 * 文本协议解析：从模型输出里认出工具调用行。
 *
 * 只认**单独一行**的 JSON，且必须含 tool/name + args；
 * 模型给的最终答案（analysis JSON 之类）不会被误判成工具调用。
 */
export function parseToolCallFromText(text: string): { name: string; args: unknown }[] | undefined {
  for (const line of text.split("\n").slice(0, 5)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const name = String(obj.tool ?? obj.name ?? "").trim();
    if (!name) continue;
    const args = obj.args ?? obj.arguments ?? obj.parameters ?? {};
    return [{ name, args }];
  }
  return undefined;
}

/** 把消息历史拍平成一段文本（文本协议用）。 */
function dumpMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === "tool") return `[工具结果 ${m.name ?? ""}]\n${m.content}`;
      if (m.role === "system") return m.content;
      return `${m.role === "user" ? "用户" : "助手"}：${m.content}`;
    })
    .join("\n\n");
}

function briefOf(tool: string, result: { ok: boolean; data?: unknown; error?: string }): string {
  if (!result.ok) return `失败(${result.error ?? "未知"})`;
  const data = result.data as Record<string, unknown> | undefined;
  if (!data) return "ok";
  if (tool === "search_news") {
    const n = (data.news as unknown[] | undefined)?.length ?? 0;
    return `${n} 条`;
  }
  if (tool === "get_history") {
    return `${data.count}根 涨跌${pctText(Number(data.changePct ?? 0))} 回撤${pctText(Number(data.maxDrawdownPct ?? 0))}`;
  }
  if (tool === "get_quote") return String(data.price ?? "");
  if (tool === "list_candidates") return `${((data.candidates as string[]) ?? []).length} 个`;
  if (tool === "get_allocation") {
    const holdings = (data.holdings as unknown[] | undefined) ?? [];
    return `现金${pctText(Number(data.cashWeight ?? 0))} 持仓${holdings.length}个`;
  }
  if (tool === "get_performance") return `收益${pctText(Number(data.totalReturn ?? 0))}`;
  return "ok";
}

function pctText(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

async function callWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return p;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`模型调用超时 ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type { ToolSpec };