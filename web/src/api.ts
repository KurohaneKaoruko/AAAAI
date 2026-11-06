/** API 客户端与 SSE 订阅。 */

import type {
  AdapterMeta,
  BacktestResult,
  PoolCounts,
  AuthStatus,
  Bot,
  BotInput,
  StrategyProfile,
  EvolutionView,
  NewsItem,
  NewsStatus,
  ComparisonResult,
  LlmOverview,
  LlmProfile,
  PopularSymbol,
  RunnerKind,
  SystemOnePreset,
  AppConfig,
  Broadcast,
  Connection,
  Connection as Conn,
  EngineState,
  SymbolInfo,
  Ticker,
  WatchItem,
  Participant,
  KlineBar,
} from "./types";

const BASE = import.meta.env.DEV ? "http://localhost:8787" : "";

export class AuthError extends Error {
  constructor() {
    super("需要登录");
    this.name = "AuthError";
  }
}

/** /api/logs 的行（level 与服务端 logger 对齐）。 */
export interface LogLineView {
  time: string;
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  message: string;
}

/** 带鉴权与 BASE 的请求；apiGet 等外部模块也复用这一条。 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    ...init,
  });
  if (res.status === 401) throw new AuthError();
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  // 引擎
  state: () => request<EngineState>("/api/state"),
  /** 历史模拟（回测）：跑一段真实历史，一次性返回战绩。不属于任何机器人。 */
  runBacktest: (body: {
    connectionId: string;
    symbols: string[];
    strategyId: string;
    interval?: string;
    barCount?: number;
    initialCash?: number;
    maxDrawdownPct?: number;
    minTradeValue?: number;
  }) => request<{ result: BacktestResult }>("/api/backtest", { method: "POST", body: JSON.stringify(body) }),
  refreshTickers: () => request<{ tickers: Ticker[] }>("/api/tickers/refresh", { method: "POST" }),

  // 配置
  config: () => request<{ config: AppConfig }>("/api/config"),
  /** warnings = 非法字段清单（保存成功但部分字段未按输入生效时服务端返回） */
  saveConfig: (patch: Partial<AppConfig>) =>
    request<{ config: AppConfig; warnings?: string[] }>("/api/config", { method: "POST", body: JSON.stringify(patch) }),
  persistConfig: () => request<{ saved: string }>("/api/config/persist", { method: "POST" }),
  // LLM 多实例
  llmProfiles: () =>
    request<{
      profiles: LlmProfile[];
      overview: LlmOverview;
      pools: PoolCounts;
      strategy: string;
      strategies: { value: string; label: string }[];
    }>("/api/llm/profiles"),
  createLlm: (body: {
    label: string;
    kind: "chat" | "systemone";
    baseUrl: string;
    model: string;
    apiKey?: string;
    provider?: string;
    levels?: string[];
    levelWeights?: number[];
    instructions?: string;
    temperature?: number;
    timeoutMs?: number;
    weight?: number;
    enabled?: boolean;
  }) =>
    request<{ profile: LlmProfile }>("/api/llm/profiles", { method: "POST", body: JSON.stringify(body) }),
  updateLlm: (id: string, body: Record<string, unknown>) =>
    request<{ profile: LlmProfile }>(`/api/llm/profiles/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteLlm: (id: string) => request<{ removed: string }>(`/api/llm/profiles/${id}`, { method: "DELETE" }),
  testLlm: (id: string, prompt: string) =>
    request<{ ok: boolean; message: string; latencyMs: number }>(`/api/llm/profiles/${id}/test`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
    }),
  resetLlmStats: (id: string) =>
    request<{ profiles: LlmProfile[] }>(`/api/llm/profiles/${id}/reset`, { method: "POST" }),
  llmPresets: () =>
    request<{
      presets: SystemOnePreset[];
      levels: string[];
      levelWeights: number[];
      instructions: string;
    }>("/api/llm/presets"),

  // 前推验证 / 稳健性
  robustness: (symbols?: string[]) =>
    request<{
      best: { fast: number; slow: number; targetWeight: number; returnPct: number; drawdown: number } | null;
      median: number;
      plateauRatio: number;
      overfitRisk: boolean;
      cells: { fast: number; slow: number; targetWeight: number; returnPct: number; drawdown: number }[];
    }>(`/api/validation/robustness${symbols?.length ? `?symbols=${symbols.join(",")}` : ""}`),
  walkForward: (symbols?: string[]) =>
    request<{
      folds: {
        fold: number;
        isBars: number;
        oosBars: number;
        isReturn: number;
        oosReturn: number;
        oosFills: number;
        gap: number;
      }[];
      avgOosReturn: number;
      avgGap: number;
      oosPositiveRatio: number;
    }>(`/api/validation/walk-forward${symbols?.length ? `?symbols=${symbols.join(",")}` : ""}`),
  // 新闻情报
  news: () => request<{ items: NewsItem[]; status: NewsStatus }>("/api/news"),
  refreshNews: (symbols?: string[]) =>
    request<{ items: NewsItem[]; errors: { provider: string; message: string }[] }>("/api/news/refresh", {
      method: "POST",
      body: JSON.stringify({ symbols }),
    }),

  // 自我进化
  evolution: () => request<EvolutionView>("/api/evolution"),
  evaluateEvolution: (force = false) =>
    request<{ applied: unknown[]; view: EvolutionView }>("/api/evolution/evaluate", {
      method: "POST",
      body: JSON.stringify({ force }),
    }),
  rollbackEvolution: () =>
    request<{ reverted: unknown; view: EvolutionView }>("/api/evolution/rollback", { method: "POST" }),

  // 交易机器人
  strategies: () => request<{ strategies: StrategyProfile[]; defaultId: string }>("/api/strategies"),
  createStrategy: (body: Partial<StrategyProfile>) =>
    request<{ strategy: StrategyProfile }>("/api/strategies", { method: "POST", body: JSON.stringify(body) }),
  updateStrategy: (id: string, body: Partial<StrategyProfile>) =>
    request<{ strategy: StrategyProfile }>(`/api/strategies/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  duplicateStrategy: (id: string) =>
    request<{ strategy: StrategyProfile }>(`/api/strategies/duplicate/${id}`, { method: "POST" }),
  setDefaultStrategy: (id: string) =>
    request<{ strategy: StrategyProfile }>(`/api/strategies/${id}/default`, { method: "POST" }),
  deleteStrategy: (id: string) =>
    request<{ removed: string }>(`/api/strategies/${id}`, { method: "DELETE" }),
  /** 自定义策略快速校验：只编译（语法/危险写法），不拉行情。 */
  checkStrategyCode: (code: string) =>
    request<{ ok: boolean; warmup?: number; error?: string }>("/api/strategies/check", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  /** 自定义策略试跑：真实行情逐根喂入，返回权重轨迹（只读行情不下单）。 */
  tryStrategyCode: (body: { code: string; connectionId?: string; symbols?: string[]; interval?: string; barCount?: number }) =>
    request<{
      warmup: number;
      bars: number;
      results: { symbol: string; count: number; error?: string; weights: { t: string; w?: number; reason?: string }[] }[];
    }>("/api/strategies/try", { method: "POST", body: JSON.stringify(body) }),
  bots: () => request<{ bots: Bot[] }>("/api/bots"),
  createBot: (body: BotInput) => request<{ bot: Bot }>("/api/bots", { method: "POST", body: JSON.stringify(body) }),
  updateBot: (id: string, body: Partial<BotInput>) =>
    request<{ bot: Bot }>(`/api/bots/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteBot: (id: string) => request<{ removed: string }>(`/api/bots/${id}`, { method: "DELETE" }),
  startBot: (id: string) => request<{ state: unknown; bot: Bot }>(`/api/bots/${id}/start`, { method: "POST" }),
  stopBot: (id: string) => request<{ state: unknown }>(`/api/bots/${id}/stop`, { method: "POST" }),
  startAllBots: (ids?: string[]) =>
    request<{ bots: Bot[] }>("/api/bots/start-all", { method: "POST", body: JSON.stringify({ ids }) }),
  stopAllBots: () => request<{ bots: Bot[] }>("/api/bots/stop-all", { method: "POST" }),

  /** K 线（实时行情图）：timestamp 是收盘时间（ISO 字符串），按时间升序。 */
  klines: (query: { connectionId: string; symbol: string; interval: string; limit?: number }) => {
    const q = new URLSearchParams({
      connectionId: query.connectionId,
      symbol: query.symbol,
      interval: query.interval,
      limit: String(query.limit ?? 300),
    });
    return request<{ bars: KlineBar[] }>(`/api/klines?${q.toString()}`);
  },

  // 模拟对照：参赛者 = 机器人 / 策略 / 模型 / 基线
  participants: (connectionId?: string) =>
    request<{ participants: Participant[]; target: EngineState["runTarget"] }>(
      `/api/bench/participants${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ""}`,
    ),
  runComparison: (body: {
    /** 参赛者 key 列表 */
    keys: string[];
    /** 对照连接（不填 = 全局默认） */
    connectionId?: string;
    symbols?: string[];
    bars?: number;
    interval?: string;
  }) => request<{ result: ComparisonResult }>("/api/bench/compare", { method: "POST", body: JSON.stringify(body) }),
  lastComparison: () => request<{ result: ComparisonResult | null }>("/api/bench/compare"),

  lbTest: (prompt: string) =>
    request<{ ok: boolean; text: string; latencyMs: number }>("/api/llm/test", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    }),

  // 鉴权：只有一个密码。needsSetup = 还没设过密码（首启引导）。
  authStatus: () =>
    request<{
      needsSetup: boolean;
      hasPassword: boolean;
      authenticated: boolean;
    }>("/api/auth/status"),
  /**
   * 登录失败必须显示服务端的真实原因（密码错），
   * 不能走 request() 的统一 401 映射——那里会显示「需要登录」，
   * 用户会误以为登录页卡住了，而看不出是自己密码打错。
   */
  login: async (password: string) => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ password }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok) throw new Error(data.error ?? `登录失败（HTTP ${res.status}）`);
    return data as { ok: boolean };
  },
  /** 首次设置密码；password 为空 = 跳过（不设密码，面板免登录）。 */
  setupPassword: async (password: string) => {
    const res = await fetch(`${BASE}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(password ? { password } : { skip: true }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok) throw new Error(data.error ?? `设置失败（HTTP ${res.status}）`);
    return data as { ok: boolean };
  },
  changePassword: (oldPassword: string, newPassword: string) =>
    request<{ ok: boolean }>("/api/auth/change", {
      method: "POST",
      body: JSON.stringify({ oldPassword, newPassword }),
    }),
  removePassword: (oldPassword: string) =>
    request<{ ok: boolean; removed: boolean }>("/api/auth/remove", {
      method: "POST",
      body: JSON.stringify({ oldPassword }),
    }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  /** 服务端运行日志（环形缓冲，最新在后）。 */
  logs: (limit = 300) =>
    request<{ logs: LogLineView[] }>(`/api/logs?limit=${encodeURIComponent(String(limit))}`),

  // 交易所
  exchanges: () => request<{ adapters: AdapterMeta[] }>("/api/exchanges"),
  connections: () => request<{ connections: Connection[] }>("/api/connections"),
  createConnection: (body: {
    adapterId: string;
    label: string;
    testnet?: boolean;
    /** 连接级交易模式；仅对 Gate 这类现货/合约双模适配器有意义 */
    tradingMode?: "spot" | "futures";
    apiKey?: string;
    apiSecret?: string;
  }) =>
    request<{ connection: Connection }>("/api/connections", { method: "POST", body: JSON.stringify(body) }),
  updateConnection: (id: string, body: Partial<Conn>) =>
    request<{ connection: Connection }>(`/api/connections/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteConnection: (id: string) => request<{ removed: string }>(`/api/connections/${id}`, { method: "DELETE" }),
  testConnection: (id: string) => request<{ ok: boolean; message: string }>(`/api/connections/${id}/test`, { method: "POST" }),

  // 标的
  popular: (connectionId: string, limit = 12) =>
    request<{
      connectionId: string;
      source: string;
      live: boolean;
      symbols: PopularSymbol[];
    }>(`/api/markets/popular?connectionId=${encodeURIComponent(connectionId)}&limit=${limit}`),

  search: (connectionId: string, q: string) =>
    request<{ symbols: SymbolInfo[] }>(`/api/markets/search?connectionId=${encodeURIComponent(connectionId)}&q=${encodeURIComponent(q)}`),
  watchlist: () => request<{ items: WatchItem[] }>("/api/watchlist"),
  addWatch: (body: { symbol: string; name: string; assetClass: string; currency: string; connectionId: string }) =>
    request<{ item: WatchItem }>("/api/watchlist", { method: "POST", body: JSON.stringify(body) }),
  removeWatch: (id: string) => request<{ removed: string }>(`/api/watchlist/${id}`, { method: "DELETE" }),
};

/**
 * SSE 订阅。
 *
 * 两个坑都在这里处理：
 * 1. onStatus 必须同时接住 onopen/onerror —— 只在 onmessage 里置 true 的话，
 *    断线后界面会一直显示“实时”，把过期数据当实时比没有数据更危险。
 * 2. 浏览器原生 EventSource 的自动重连在部分环境里不会重新触发 onopen；
 *    这里显式关闭并按 3 秒重建，服务重启后界面能自己恢复。
 */
export function subscribeEvents(
  onMessage: (b: Broadcast) => void,
  onStatus?: (connected: boolean) => void,
): () => void {
  const url = `${BASE}/api/events`;
  let es: EventSource | null = null;
  let timer: number | null = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    es = new EventSource(url, { withCredentials: true });
    es.onopen = () => {
      if (!closed) onStatus?.(true);
    };
    es.onmessage = (ev) => {
      if (closed) return;
      try {
        onMessage(JSON.parse(ev.data) as Broadcast);
        onStatus?.(true);
      } catch {
        /* 忽略心跳 */
      }
    };
    es.onerror = () => {
      if (closed) return;
      onStatus?.(false);
      // 主动重建：关掉原生连接，避免和浏览器的自动重连叠在一起
      es?.close();
      es = null;
      if (closed || timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        connect();
      }, 3000);
    };
  };

  connect();
  return () => {
    closed = true;
    if (timer !== null) window.clearTimeout(timer);
    es?.close();
  };
}
