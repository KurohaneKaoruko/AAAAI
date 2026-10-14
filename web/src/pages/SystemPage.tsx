/** 系统页：运行信息、配置持久化、服务端日志。 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AppStore } from "../state/useAppStore";
import { Button, Notice, Panel } from "../components/ui";
import { dateTime } from "../lib/format";

interface LogLine {
  time: string;
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  message: string;
}

export function SystemPage({ store }: { store: AppStore }) {
  const state = store.state;
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [logFilter, setLogFilter] = useState<"all" | "warn" | "error">("all");

  const loadLogs = useCallback(async () => {
    try {
      const res = await fetch(`${import.meta.env.DEV ? "http://localhost:8787" : ""}/api/logs?limit=300`);
      const data = (await res.json()) as { logs: LogLine[] };
      setLogs(data.logs);
    } catch {
      /* 服务未就绪时忽略 */
    }
  }, []);

  useEffect(() => {
    void loadLogs();
    const t = setInterval(() => void loadLogs(), 5000);
    return () => clearInterval(t);
  }, [loadLogs]);

  if (!state) return <div className="loading">加载中…</div>;

  const persist = async () => {
    setError(null);
    try {
      const r = await api.persistConfig();
      setSaved(r.saved);
      store.toast("success", "配置已写入文件");
    } catch (err) {
      setError((err as Error).message);
      store.toast("error", "写入失败");
    }
  };

  const refreshTickers = async () => {
    try {
      await api.refreshTickers();
      await store.reloadState();
      store.toast("success", "行情已刷新");
    } catch (err) {
      store.toast("error", (err as Error).message);
    }
  };

  const uptime = state.startedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(state.startedAt)) / 1000))
    : 0;

  const visibleLogs = logs.filter((l) =>
    logFilter === "all" ? true : logFilter === "warn" ? l.level === "warn" : l.level === "error",
  );

  return (
    <div className="page page-system">
      <div className="grid-2">
        <Panel title="运行信息">
          <table className="kv-table">
            <tbody>
              <tr>
                <td>服务</td>
                <td>{state.config.app.name} v0.1.0</td>
              </tr>
              <tr>
                <td>地址</td>
                <td className="mono">
                  {state.config.server.host}:{state.config.server.port}
                </td>
              </tr>
              <tr>
                <td>状态</td>
                <td>{state.status}</td>
              </tr>
              <tr>
                <td>开始时间</td>
                <td className="mono">{dateTime(state.startedAt)}</td>
              </tr>
              <tr>
                <td>已运行</td>
                <td>{uptime} 秒</td>
              </tr>
              <tr>
                <td>默认连接</td>
                <td>{state.config.execution.connectionId || "（自动选择第一个）"}</td>
              </tr>
              <tr>
                <td>执行方式</td>
                <td>{state.config.execution.mode === "live" ? "真实下单" : "模拟成交"}</td>
              </tr>
              <tr>
                <td>实时通道</td>
                <td>{store.connected ? "正常" : "断开"}</td>
              </tr>
            </tbody>
          </table>
        </Panel>

        <Panel title="维护操作">
          <div className="btn-column">
            <Button onClick={refreshTickers}>刷新自选行情</Button>
            <Button variant="primary" onClick={persist}>
              将当前设置写入配置文件
            </Button>
            <Button onClick={() => setShowJson((v) => !v)}>
              {showJson ? "隐藏" : "查看"}当前配置 JSON
            </Button>
          </div>
          {saved && <Notice tone="success">已保存到 {saved}</Notice>}
          {error && <Notice tone="error">{error}</Notice>}
          {showJson && <pre className="json-view mono">{JSON.stringify(state.config, null, 2)}</pre>}
          <div className="explain-box">
            <strong>数据存放位置</strong>
            <ul className="notes">
              <li>
                <code>data/connections.json</code> 交易所连接（非密钥）
              </li>
              <li>
                <code>data/secrets.json</code> API 密钥（0600，已 gitignore）
              </li>
              <li>
                <code>data/watchlist.json</code> 候选池（watchlist.json）
              </li>
              <li>
                <code>config/default.yaml</code> 主配置（保存时写回）
              </li>
            </ul>
          </div>
        </Panel>
      </div>

      <Panel
        title="服务日志"
        subtitle={`${visibleLogs.length} 行 · 每 5 秒自动刷新`}
        actions={
          <div className="tabs">
            {(["all", "warn", "error"] as const).map((f) => (
              <button key={f} type="button" className={`tab ${logFilter === f ? "tab-on" : ""}`} onClick={() => setLogFilter(f)}>
                {f === "all" ? "全部" : f === "warn" ? "警告" : "错误"}
              </button>
            ))}
            <Button small onClick={() => void loadLogs()}>
              手动刷新
            </Button>
          </div>
        }
      >
        <div className="log-tail">
          {visibleLogs.length === 0 && <div className="empty">暂无日志</div>}
          {visibleLogs.map((l, i) => (
            <div className={`log-line log-${l.level}`} key={`${l.time}-${i}`}>
              <span className="mono log-time">{l.time.slice(11, 19)}</span>
              <span className={`log-level mono log-lv-${l.level}`}>{l.level.toUpperCase()}</span>
              <span className="log-scope mono">{l.scope}</span>
              <span className="log-msg mono">{l.message}</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}