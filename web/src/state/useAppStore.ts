/** 全局状态：引擎快照 + SSE 实时推送 + 配置与连接缓存。 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, request, subscribeEvents } from "../api";
import type { AdapterMeta, AppConfig, Bot, Broadcast, Connection, EngineState, WatchItem } from "../types";

/**
 * 裸 fetch 的统一替换：开发模式打 8787、生产打同源，并自动带上鉴权 Token。
 * 直接写 fetch("/api/...") 在开发模式会打到 5173（Vite 不代理后端），
 * 开了鉴权后也会因缺 Authorization 被拦 —— 两边都是"页面数据莫名全空"。
 */
export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

/** 轮询机器人列表（顶栏与仪表盘共用）。 */
export function useBotsPolling(pollMs = 3000): Bot[] {
  const [bots, setBots] = useState<Bot[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await apiGet<{ bots: Bot[] }>("/api/bots");
        if (alive && Array.isArray(d.bots)) setBots(d.bots);
      } catch {
        /* 服务不可用时保持原样 */
      }
    };
    void load();
    const t = setInterval(() => void load(), pollMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pollMs]);
  return bots;
}


export interface Toast {
  id: number;
  tone: "success" | "error" | "info" | "warn";
  text: string;
}

export interface AppStore {
  state: EngineState | null;
  connections: Connection[];
  adapters: AdapterMeta[];
  watchlist: WatchItem[];
  connected: boolean;
  /** 首屏 /api/state 拉取失败的原因；null = 正常或尚未失败 */
  bootError: string | null;
  toasts: Toast[];
  toast: (tone: Toast["tone"], text: string) => void;
  dismiss: (id: number) => void;
  reloadConnections: () => Promise<void>;
  reloadWatchlist: () => Promise<void>;
  reloadAdapters: () => Promise<void>;
  /** 首屏四件套一起重拉：登录成功后必须调一次，见下方注释 */
  reloadAll: () => Promise<void>;
  /** 保存配置；返回是否成功。失败时已经弹过 toast，调用方据此决定后续动作。 */
  patchConfig: (patch: Partial<AppConfig>) => Promise<boolean>;
  reloadState: () => Promise<void>;
}

export function useAppStore(): AppStore {
  const [state, setState] = useState<EngineState | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [adapters, setAdapters] = useState<AdapterMeta[]>([]);
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

  const toast = useCallback((tone: Toast["tone"], text: string) => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setToasts((prev) => [...prev, { id, tone, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const reloadConnections = useCallback(async () => {
    try {
      const { connections: list } = await api.connections();
      setConnections(list);
    } catch (err) {
      toast("error", (err as Error).message);
    }
  }, [toast]);

  const reloadWatchlist = useCallback(async () => {
    try {
      const { items } = await api.watchlist();
      setWatchlist(items);
    } catch (err) {
      toast("error", (err as Error).message);
    }
  }, [toast]);

  const reloadAdapters = useCallback(async () => {
    try {
      const { adapters: list } = await api.exchanges();
      setAdapters(list);
    } catch (err) {
      toast("error", (err as Error).message);
    }
  }, [toast]);

  const reloadState = useCallback(async () => {
    try {
      const next = await api.state();
      setState(next);
      setBootError(null);
    } catch (err) {
      // 以前完全静默：服务没起时所有页面永远停在「正在连接…」，用户不知道该重试还是重新安装。
      setBootError((err as Error).message);
    }
  }, []);

  /** 首屏四件套：状态、连接、适配器、自选。可重复调用（登录后重拉）。 */
  const reloadAll = useCallback(async () => {
    await Promise.all([reloadState(), reloadConnections(), reloadAdapters(), reloadWatchlist()]);
  }, [reloadState, reloadConnections, reloadAdapters, reloadWatchlist]);

  const patchConfig = useCallback(
    async (patch: Partial<AppConfig>) => {
      try {
        const { config, warnings } = await api.saveConfig(patch);
        setState((prev) => (prev ? { ...prev, config } : prev));
        if (warnings && warnings.length > 0) {
          // 保存成功但部分字段非法未生效：必须说清楚是哪些，否则用户
          // 以为改成功了（如把费率填成文本，实际被回退成默认值）。
          toast("warn", `已保存，但 ${warnings.length} 项未生效：${warnings.slice(0, 3).join("；")}${warnings.length > 3 ? " 等" : ""}`);
        } else {
          toast("success", "设置已保存");
        }
        return true;
      } catch (err) {
        toast("error", (err as Error).message);
        return false;
      }
    },
    [toast],
  );

  // 首屏加载 + SSE 订阅
  //
  // 注意：这个 effect 在 App 顶层，**登录之前**就会跑一次。开启鉴权后那次请求
  // 全是 401，被各自的 catch 吞掉（不能弹错，否则登录页满屏红字），于是
  // connections/adapters 会永久停在空数组——「模拟对照」的对照连接下拉因此
  // 一个选项都没有。登录成功后由 App 调用 reloadAll() 重拉一遍。
  useEffect(() => {
    void reloadAll();

    const off = subscribeEvents((b: Broadcast) => {
      // 引擎已删除，SSE 只推送全局状态；事件流改为按机器人从 /api/bots 拉取
      setState(b.data);
    }, setConnected);
    return off;
  }, [reloadAll]);

  return {
    state,
    connections,
    adapters,
    watchlist,
    connected,
    bootError,
    toasts,
    toast,
    dismiss,
    reloadConnections,
    reloadWatchlist,
    reloadAdapters,
    reloadAll,
    patchConfig,
    reloadState,
  };
}