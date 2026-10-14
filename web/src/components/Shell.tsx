/** 侧边导航 + 顶栏 + 行情跑马灯 + 主题切换 + 提示条。 */

import type { ReactNode } from "react";
import type { AppStore } from "../state/useAppStore";
import type { EngineState } from "../types";
import type { Theme } from "../lib/theme";
import { Badge } from "./ui";
import { ASSET_LABEL, money, pct } from "../lib/format";

export type PageId =
  | "dashboard"
  | "bots"
  | "exchanges"
  | "strategy"
  | "llm"
  | "compare"
  | "risk"
  | "system";

const NAV: { id: PageId; label: string; icon: string; group: string }[] = [
  { id: "dashboard", label: "仪表盘", icon: "◧", group: "交易" },
  { id: "bots", label: "交易机器人", icon: "❖", group: "交易" },
  { id: "exchanges", label: "交易所连接", icon: "⇄", group: "交易" },
  { id: "strategy", label: "策略", icon: "⚑", group: "智能" },
  { id: "llm", label: "模型管理", icon: "✦", group: "智能" },
  { id: "compare", label: "模型对照", icon: "⇆", group: "智能" },
  { id: "risk", label: "风控", icon: "⛨", group: "系统" },
  { id: "system", label: "系统与日志", icon: "⚙", group: "系统" },
];

const STATUS_TEXT: Record<EngineState["status"], string> = {
  idle: "待机",
  running: "运行中",
  stopped: "已停止",
  error: "异常",
};

export function Sidebar({
  page,
  onNavigate,
  connections,
}: {
  page: PageId;
  onNavigate: (p: PageId) => void;
  connections: AppStore["connections"];
}) {
  const groups = [...new Set(NAV.map((n) => n.group))];
  return (
    <nav className="sidebar">
      <div className="brand">
        <span className="logo">AAAAI</span>
        <span className="brand-sub">多智能体投研</span>
      </div>
      {groups.map((g) => (
        <div className="nav-group" key={g}>
          <div className="nav-group-title">{g}</div>
          {NAV.filter((n) => n.group === g).map((n) => (
            <button
              key={n.id}
              type="button"
              className={`nav-item ${page === n.id ? "nav-active" : ""}`}
              onClick={() => onNavigate(n.id)}
            >
              <span className="nav-icon">{n.icon}</span>
              {n.label}
              {n.id === "exchanges" && connections.length > 0 && (
                <span className="nav-count">{connections.length}</span>
              )}
            </button>
          ))}
        </div>
      ))}
      <div className="sidebar-foot">
        <span className="dot dot-live" /> 模拟盘优先
        <br />
        <small>Ai-Agent-Auto-Asset-Investment</small>
      </div>
    </nav>
  );
}

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      title={isDark ? "切换到亮色主题" : "切换到暗色主题"}
      aria-label="切换主题"
    >
      <span className="theme-icon">{isDark ? "☾" : "☀"}</span>
      {isDark ? "暗色" : "亮色"}
    </button>
  );
}

export function TopBar({
  store,
  actions,
  theme,
  onToggleTheme,
}: {
  store: AppStore;
  actions: ReactNode;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const state = store.state;
  const tickers = state?.tickers ?? [];
  return (
    <header className="topbar">
      <div className="topbar-main">
        <span className={`badge badge-${state?.status ?? "idle"}`}>
          {STATUS_TEXT[state?.status ?? "idle"]}
        </span>
        {state?.mode && (
          <span className="chip">
            {state.mode === "live" ? "实时" : "回测"} · {state.symbols.join(" / ") || "无标的"}
          </span>
        )}
        {state?.connectionLabel && <span className="chip">连接: {state.connectionLabel}</span>}
        {state?.broker && (
          <span className={`chip ${state.broker.paper ? "" : "chip-live"}`}>
            {state.broker.paper ? "模拟成交" : "真实下单"}
          </span>
        )}
        {state?.strategy && <span className="chip">策略: {state.strategy}</span>}
        <span className={`chip ${store.connected ? "chip-ok" : "chip-off"}`}>
          {store.connected ? "实时通道 OK" : "通道断开"}
        </span>
      </div>
      <div className="topbar-actions">
        {actions}
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>
      {tickers.length > 0 && (
        <div className="ticker-strip">
          {tickers.slice(0, 12).map((t) => (
            <span className="ticker-item" key={t.symbol}>
              <span className="ticker-symbol">{t.symbol}</span>
              <span className="ticker-price mono">{money(t.price, t.price > 100 ? 2 : 4)}</span>
              <span className={`ticker-change mono ${t.changePct >= 0 ? "up" : "down"}`}>
                {pct(t.changePct)}
              </span>
            </span>
          ))}
        </div>
      )}
    </header>
  );
}

export function Toasts({ store }: { store: AppStore }) {
  return (
    <div className="toasts">
      {store.toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`} onClick={() => store.dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function AssetBadge({ assetClass }: { assetClass: string }) {
  return <Badge tone={assetClass === "crypto" ? "accent" : "warn"}>{ASSET_LABEL[assetClass] ?? assetClass}</Badge>;
}