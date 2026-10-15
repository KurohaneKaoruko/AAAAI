/** 全局状态：引擎快照 + SSE 实时推送 + 配置与连接缓存。 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribeEvents } from "../api";
import type { AdapterMeta, AppConfig, Broadcast, Connection, EngineState, WatchItem } from "../types";


export interface Toast {
  id: number;
  tone: "success" | "error" | "info";
  text: string;
}

export interface AppStore {
  state: EngineState | null;
  connections: Connection[];
  adapters: AdapterMeta[];
  watchlist: WatchItem[];
  connected: boolean;
  toasts: Toast[];
  toast: (tone: Toast["tone"], text: string) => void;
  dismiss: (id: number) => void;
  reloadConnections: () => Promise<void>;
  reloadWatchlist: () => Promise<void>;
  reloadAdapters: () => Promise<void>;
  patchConfig: (patch: Partial<AppConfig>) => Promise<void>;
  reloadState: () => Promise<void>;
}

export function useAppStore(): AppStore {
  const [state, setState] = useState<EngineState | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [adapters, setAdapters] = useState<AdapterMeta[]>([]);
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [connected, setConnected] = useState(false);
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
    } catch {
      /* 服务未就绪时忽略 */
    }
  }, []);

  const patchConfig = useCallback(
    async (patch: Partial<AppConfig>) => {
      try {
        const { config } = await api.saveConfig(patch);
        setState((prev) => (prev ? { ...prev, config } : prev));
        toast("success", "设置已保存");
      } catch (err) {
        toast("error", (err as Error).message);
      }
    },
    [toast],
  );

  // 首屏加载 + SSE 订阅
  useEffect(() => {
    void reloadState();
    void reloadConnections();
    void reloadAdapters();
    void reloadWatchlist();

    const off = subscribeEvents((b: Broadcast) => {
      // 引擎已删除，SSE 只推送全局状态；事件流改为按机器人从 /api/bots 拉取
      setConnected(true);
      setState(b.data);
    });
    return off;
  }, [reloadState, reloadConnections, reloadAdapters, reloadWatchlist]);

  return {
    state,
    connections,
    adapters,
    watchlist,
    connected,
    toasts,
    toast,
    dismiss,
    reloadConnections,
    reloadWatchlist,
    reloadAdapters,
    patchConfig,
    reloadState,
  };
}