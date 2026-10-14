/** API 客户端：REST + SSE。开发期直连 8787，生产同源。 */

import type { Broadcast, EngineState } from "./types.js";

const BASE = import.meta.env.DEV ? "http://localhost:8787" : "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export const api = {
  state: () => request<EngineState>("/api/state"),

  start: (mode: "backtest" | "live", opts: { symbol?: string; bars?: number } = {}) =>
    request<{ ok: boolean }>("/api/engine/start", {
      method: "POST",
      body: JSON.stringify({ mode, ...opts }),
    }),

  stop: () => request<{ ok: boolean }>("/api/engine/stop", { method: "POST" }),

  saveConfig: (patch: unknown) =>
    request<{ ok: boolean }>("/api/config", { method: "POST", body: JSON.stringify(patch) }),
};

/** 订阅引擎广播；返回取消订阅函数。 */
export function subscribeEvents(onMessage: (b: Broadcast) => void): () => void {
  const es = new EventSource(`${BASE}/api/events`);
  es.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(ev.data) as Broadcast);
    } catch {
      /* 忽略心跳/坏行 */
    }
  };
  es.onerror = () => {
    /* EventSource 自动重连 */
  };
  return () => es.close();
}
