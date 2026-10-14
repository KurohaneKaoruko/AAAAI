/** API 客户端与 SSE 订阅。 */

import type {
  AdapterMeta,
  AppConfig,
  Broadcast,
  Connection,
  Connection as Conn,
  EngineState,
  SymbolInfo,
  Ticker,
  WatchItem,
} from "./types";

const BASE = import.meta.env.DEV ? "http://localhost:8787" : "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  // 引擎
  state: () => request<EngineState>("/api/state"),
  start: (body: { mode: "backtest" | "live"; symbols?: string[]; connectionId?: string; bars?: number; interval?: string }) =>
    request<{ state: EngineState }>("/api/engine/start", { method: "POST", body: JSON.stringify(body) }),
  stop: () => request<{ state: EngineState }>("/api/engine/stop", { method: "POST" }),
  refreshTickers: () => request<{ tickers: Ticker[] }>("/api/tickers/refresh", { method: "POST" }),

  // 配置
  config: () => request<{ config: AppConfig }>("/api/config"),
  saveConfig: (patch: Partial<AppConfig>) =>
    request<{ config: AppConfig }>("/api/config", { method: "POST", body: JSON.stringify(patch) }),
  persistConfig: () => request<{ saved: string }>("/api/config/persist", { method: "POST" }),
  testLlm: (prompt: string) =>
    request<{ ok: boolean; text: string }>("/api/llm/test", { method: "POST", body: JSON.stringify({ prompt }) }),

  // 交易所
  exchanges: () => request<{ adapters: AdapterMeta[] }>("/api/exchanges"),
  connections: () => request<{ connections: Connection[] }>("/api/connections"),
  createConnection: (body: { adapterId: string; label: string; testnet?: boolean; apiKey?: string; apiSecret?: string }) =>
    request<{ connection: Connection }>("/api/connections", { method: "POST", body: JSON.stringify(body) }),
  updateConnection: (id: string, body: Partial<Conn>) =>
    request<{ connection: Connection }>(`/api/connections/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteConnection: (id: string) => request<{ removed: string }>(`/api/connections/${id}`, { method: "DELETE" }),
  testConnection: (id: string) => request<{ ok: boolean; message: string }>(`/api/connections/${id}/test`, { method: "POST" }),

  // 标的
  search: (connectionId: string, q: string) =>
    request<{ symbols: SymbolInfo[] }>(`/api/markets/search?connectionId=${encodeURIComponent(connectionId)}&q=${encodeURIComponent(q)}`),
  watchlist: () => request<{ items: WatchItem[] }>("/api/watchlist"),
  addWatch: (body: { symbol: string; name: string; assetClass: string; currency: string; connectionId: string }) =>
    request<{ item: WatchItem }>("/api/watchlist", { method: "POST", body: JSON.stringify(body) }),
  removeWatch: (id: string) => request<{ removed: string }>(`/api/watchlist/${id}`, { method: "DELETE" }),
};

/** 订阅引擎广播；返回取消订阅函数。 */
export function subscribeEvents(onMessage: (b: Broadcast) => void): () => void {
  const es = new EventSource(`${BASE}/api/events`);
  es.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(ev.data) as Broadcast);
    } catch {
      /* 忽略心跳 */
    }
  };
  return () => es.close();
}