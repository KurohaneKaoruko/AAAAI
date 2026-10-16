/** 侧边导航 + 顶栏 + 行情跑马灯 + 主题切换 + 提示条。 */

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AppStore } from "../state/useAppStore";
import type { Bot } from "../types";
import type { Theme } from "../lib/theme";
import { Badge } from "./ui";
import { ASSET_LABEL, money, pct } from "../lib/format";

export type PageId =
  | "dashboard"
  | "bots"
  | "backtest"
  | "exchanges"
  | "strategy"
  | "llm"
  | "compare"
  | "risk"
  | "system";

// 分组即心智：交易 = 现在就要动手的（跑机器人、连交易所）；
// 智能 = 动手之前的准备与复盘（策略、模型、让它们同场比一比、拿历史先验一验）。
// 历史模拟放在「智能」组末尾，紧挨模拟对照：两者都是"先验证再上实盘"。
const NAV: { id: PageId; label: string; icon: string; group: string }[] = [
  { id: "dashboard", label: "仪表盘", icon: "◧", group: "交易" },
  { id: "bots", label: "交易机器人", icon: "❖", group: "交易" },
  { id: "exchanges", label: "交易所连接", icon: "⇄", group: "交易" },
  { id: "strategy", label: "策略", icon: "⚑", group: "智能" },
  { id: "llm", label: "模型管理", icon: "✦", group: "智能" },
  { id: "compare", label: "模拟对照", icon: "⇆", group: "智能" },
  { id: "backtest", label: "历史模拟", icon: "⏱", group: "智能" },
  { id: "risk", label: "风控", icon: "⛨", group: "系统" },
  { id: "system", label: "系统与日志", icon: "⚙", group: "系统" },
];

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

/**
 * 顶栏最多放几个行情。
 *
 * 顶栏是"扫一眼"的地方，不是行情列表：放满了就换行，超出的在末尾说还有几个，
 * 完整列表在「策略 → 候选池」页。以前是一行横着滚，超出的直接被裁掉，
 * 看不出"还有"还是"就这些"。
 */
const MAX_TOP_TICKERS = 12;

export function TopBar({
  store,
  theme,
  onToggleTheme,
}: {
  store: AppStore;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const state = store.state;
  const tickers = state?.tickers ?? [];
  // 顶栏反映的是"现在到底在跑什么" = 机器人（单账户引擎已删除）
  const [bots, setBots] = useState<Bot[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await fetch("/api/bots").then((r) => r.json());
        if (alive && Array.isArray(d.bots)) setBots(d.bots);
      } catch {
        /* 忽略 */
      }
    };
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const running = bots.filter((b) => b.state.status === "running");
  const liveCount = running.filter((b) => b.state.liveTrading).length;
  const execMode = state?.config?.execution?.mode ?? "paper";

  return (
    <header className="topbar">
      <div className="topbar-main">
        {running.length > 0 ? (
          <>
            <span className="badge badge-running">{running.length} 个机器人运行中</span>
            {liveCount > 0 && <span className="chip chip-live">实盘下单中 · {liveCount} 个</span>}
            <span className="chip">{running.map((b) => b.name).slice(0, 3).join(" / ")}</span>
          </>
        ) : (
          <span className="badge badge-idle">待机</span>
        )}
        <span className={`chip ${execMode === "live" ? "chip-live" : ""}`}>
          {execMode === "live" ? "真实下单" : "模拟成交"}
        </span>
        <span className={`chip ${store.connected ? "chip-ok" : "chip-off"}`}>
          {store.connected ? "实时通道 OK" : "通道断开"}
        </span>
      </div>
      <div className="topbar-actions">
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>
      {tickers.length > 0 && (
        <div className="ticker-strip">
          {tickers.slice(0, MAX_TOP_TICKERS).map((t) => (
            <span className="ticker-item" key={t.symbol}>
              <span className="ticker-symbol">{t.symbol}</span>
              <span className="ticker-price mono">{money(t.price, t.price > 100 ? 2 : 4)}</span>
              {/* 正数也带 +：只靠颜色分涨跌，色弱的人看不出方向 */}
              <span className={`ticker-change mono ${t.changePct >= 0 ? "up" : "down"}`}>
                {t.changePct >= 0 ? "+" : ""}
                {pct(t.changePct)}
              </span>
            </span>
          ))}
          {tickers.length > MAX_TOP_TICKERS && (
            <span className="ticker-more" title="顶栏只放这么多，完整的在「策略 → 候选池」">
              还有 {tickers.length - MAX_TOP_TICKERS} 个标的
            </span>
          )}
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