/**
 * 解析多轮对话 + 工具调用的返回。
 *
 * OpenAI 兼容端点返回 { content, tool_calls }；
 * 有的端点会把工具调用塞进 content 的 JSON 里，这里一并兼容。
 */

export interface ChatReply {
  content: string;
  toolCalls?: { name: string; args: unknown }[];
}

export function parseChatReply(raw: ChatReply | string): ChatReply {
  const reply: ChatReply = typeof raw === "string" ? { content: raw } : raw;
  if (reply.toolCalls && reply.toolCalls.length > 0) return reply;

  // 兜底：从文本里认出工具调用
  for (const line of reply.content.split("\n").slice(0, 5)) {
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
    return {
      content: reply.content,
      toolCalls: [{ name, args: obj.args ?? obj.arguments ?? obj.parameters ?? {} }],
    };
  }
  return reply;
}