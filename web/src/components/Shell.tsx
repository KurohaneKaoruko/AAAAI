/** 侧边导航 + 顶栏 + 行情跑马灯 + 主题切换 + 提示条。 */

import type { ReactNode } from "react";
import type { AppStore } from "../state/useAppStore";
import { useBotsPolling } from "../state/useAppStore";
import type { Theme } from "../lib/theme";
import { Badge } from "./ui";
import { ASSET_LABEL, money, signed, signedPct } from "../lib/format";

export type PageId =
  | "dashboard"
  | "bots"
  | "backtest"
  | "exchanges"
  | "strategy"
  | "llm"
  | "compare"
  | "risk"
  | "system"
  | "settings";

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
  { id: "system", label: "系统", icon: "☰", group: "系统" },
  { id: "settings", label: "设置", icon: "⚙", group: "系统" },
];

export function Sidebar({
  page,
  onNavigate,
  connections,
  connected,
}: {
  page: PageId;
  onNavigate: (p: PageId) => void;
  connections: AppStore["connections"];
  /** SSE 实时通道状态：底部活性灯据此变色 */
  connected: boolean;
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
              data-tour={`nav-${n.id}`}
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
        <LiveDot connected={connected} /> {connected ? "数据实时" : "通道断开"}
        <br />
        <small>Ai-Agent-Auto-Asset-Investment</small>
      </div>
    </nav>
  );
}

/**
 * 侧边栏底部的引擎活性灯：
 *   绿点呼吸 = SSE 实时通道连着；灰点 = 断开（数据可能已过期）。
 * 以前这颗点永远亮着，通道断了它还装活 —— 状态可见性恰恰坏在这里。
 */
export function LiveDot({ connected }: { connected: boolean }) {
  return (
    <span
      className={`dot ${connected ? "dot-live" : "dot-dead"}`}
      title={connected ? "实时通道已连接，数据为最新" : "实时通道断开，以下数据可能过期"}
    />
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
  theme,
  onToggleTheme,
  username,
  onLogout,
  onTourRestart,
}: {
  store: AppStore;
  theme: Theme;
  onToggleTheme: () => void;
  /** 鉴权已启用时传入：undefined = 未启用鉴权（不显示退出入口），空串 = 仅 Token 模式 */
  username?: string;
  onLogout?: () => void;
  /** 重看使用指引 */
  onTourRestart: () => void;
}) {
  const state = store.state;
  // 机器人状态轮询：走统一的 apiGet（带 BASE 与鉴权），与交易机器人页看到同一份数据
  const bots = useBotsPolling();
  const running = bots.filter((b) => b.state.status === "running");
  const errored = bots.filter((b) => b.state.status === "error");
  const liveCount = running.filter((b) => b.state.liveTrading).length;
  const execMode = state?.config?.execution?.mode ?? "paper";
  const withData = bots.filter((b) => b.state.metrics);
  const totalEquity = withData.reduce((a, b) => a + (b.state.metrics!.finalEquity), 0);
  // 「本次盈亏」口径：各机器人本次运行已实现盈亏合计（服务端没有按自然日切分的字段，
  // 这里如实标注为「本次盈亏」，别让用户以为按日历日算）。百分比按这些机器人的初始资金合计。
  const sessionPnl = withData.reduce((a, b) => a + (b.state.metrics!.realizedPnl), 0);
  const initialTotal = withData.reduce((a, b) => a + (b.risk.initialCash || 0), 0);
  const pnlPct = initialTotal > 0 ? sessionPnl / initialTotal : 0;

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
        {errored.length > 0 && (
          <span className="chip chip-live" title={errored.map((b) => `${b.name}: ${b.state.error ?? "未知错误"}`).join("\n")}>
            {errored.length} 个异常
          </span>
        )}
        <span className={`chip ${execMode === "live" ? "chip-live" : ""}`}>
          {execMode === "live" ? "真实下单" : "模拟成交"}
        </span>
        <span className={`chip ${store.connected ? "chip-ok" : "chip-off"}`}>
          {store.connected ? "实时通道 OK" : "通道断开"}
        </span>

        {/* 账户摘要条：总权益 + 本次盈亏。有数据才显示，别拿 0 冒充账户。 */}
        {withData.length > 0 && (
          <div className="acct-strip">
            <div className="acct-item">
              <span className="acct-label">总权益</span>
              <span className="acct-value">{money(totalEquity)}</span>
              <span className="acct-sub">{withData.length} 个账户</span>
            </div>
            <div className="acct-item">
              <span className="acct-label">本次盈亏</span>
              <span className={`acct-value ${sessionPnl > 0 ? "up" : sessionPnl < 0 ? "down" : ""}`}>
                {signed(sessionPnl)}
              </span>
              <span className={`acct-sub ${pnlPct > 0 ? "up" : pnlPct < 0 ? "down" : ""}`}>
                {signedPct(pnlPct)}
              </span>
            </div>
          </div>
        )}
      </div>
      <div className="topbar-actions">
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        {/* 使用指引：初次访问自动播放过，这里随时重看 */}
        <button
          type="button"
          data-tour="tour-restart"
          className="chip"
          title="重新查看使用指引"
          aria-label="使用指引"
          onClick={onTourRestart}
        >
          ?
        </button>
        {/* username 传 undefined = 鉴权未启用；传空串 = 仅 Token 模式（没有用户名），也显示退出 */}
        {username !== undefined && onLogout && (
          <button
            type="button"
            className="chip"
            title="退出登录（清除本地 Token 并结束服务端会话）"
            onClick={() => void onLogout()}
          >
            {username !== "" ? `${username} · 退出` : "退出登录"}
          </button>
        )}
      </div>
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