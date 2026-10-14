/** OpenAI 兼容客户端：/chat/completions，Node 18+ 原生 fetch。 */

import type { LLMClient } from "./llmClient.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("llm");

export interface OpenAICompatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
}

export class OpenAICompatClient implements LLMClient {
  readonly name = "openai-compatible";

  constructor(private readonly opts: OpenAICompatOptions) {
    if (!opts.apiKey) {
      throw new Error("LLM 已启用但未配置 API Key（检查环境变量）");
    }
  }

  async complete(prompt: string): Promise<string> {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: this.opts.temperature,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`LLM 请求失败: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM 响应缺少 content");
    log.debug("LLM 响应 %d 字节", content.length);
    return content;
  }

  /** 资产配置：对话模型用同一条 chat 接口即可，由上层解析 allocations JSON。 */
  allocate(prompt: string, _symbols: string[]): Promise<string> {
    return this.complete(prompt);
  }

  /**
   * 多轮 + 原生 function calling。
   * tools 传入 ToolBox.list() 的 JSON Schema 描述；tool 角色的结果按 OpenAI 规范回传。
   */
  async chat(
    messages: { role: "system" | "user" | "assistant" | "tool"; content: string; name?: string }[],
    tools: { name: string; description: string; parameters: Record<string, unknown> }[] = [],
  ): Promise<{ content: string; toolCalls?: { name: string; args: unknown }[] }> {
    const toolSpecs = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    const payload = messages.map((m) =>
      m.role === "tool"
        ? { role: "tool", tool_call_id: `call_${m.name ?? "tool"}`, content: m.content }
        : { role: m.role, content: m.content },
    );

    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: this.opts.temperature,
        messages: payload,
        ...(toolSpecs.length > 0 ? { tools: toolSpecs, tool_choice: "auto" } : {}),
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM 请求失败: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string; tool_calls?: { id: string; function?: { name?: string; arguments?: string } }[] } }[];
    };
    const message = data.choices?.[0]?.message;
    const calls = (message?.tool_calls ?? [])
      .map((c) => ({ name: c.function?.name ?? "", args: safeArgs(c.function?.arguments) }))
      .filter((c) => c.name.length > 0);
    return { content: message?.content ?? "", ...(calls.length > 0 ? { toolCalls: calls } : {}) };
  }
}

function safeArgs(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
