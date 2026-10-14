/** 空实现：未配置 LLM 时使用，保证流水线不依赖外部服务。 */

import type { LLMClient } from "./llmClient.js";
import { OpenAICompatClient } from "./openaiClient.js";

export class NullLLMClient implements LLMClient {
  readonly name = "null";

  async complete(): Promise<string> {
    return "";
  }
}

/** 按配置创建 LLM 客户端；未启用或缺少 Key 时返回 null。 */
export function createLLMClient(config: {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
}): LLMClient | null {
  if (!config.enabled) return null;
  if (!config.apiKey) return null;
  return new OpenAICompatClient(config);
}
