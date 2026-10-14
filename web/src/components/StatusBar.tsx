import type { EngineState } from "../types";

const STATUS_TEXT: Record<EngineState["status"], string> = {
  idle: "待机",
  running: "运行中",
  stopped: "已停止",
  error: "异常",
};

export function StatusBar({ state, error }: { state: EngineState | null; error: string | null }) {
  const status = state?.status ?? "idle";
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">AAAAI</span>
        <span className="tagline">Ai-Agent-Auto-Asset-Investment</span>
      </div>
      <div className="status-cluster">
        <span className={`badge badge-${status}`}>{STATUS_TEXT[status]}</span>
        {state?.mode && <span className="chip">模式: {state.mode === "live" ? "实时" : "回测"}</span>}
        <span className="chip">标的: {state?.symbol ?? "—"}</span>
        <span className="chip">
          券商: {state?.broker ? `${state.broker.name}${state.broker.paper ? " · 模拟" : " · 实盘"}` : "—"}
        </span>
        <span className="chip">策略: {state?.strategy ?? "—"}</span>
        <span className="chip">
          数据源: {state?.config?.market?.source ?? "—"}
          {state?.config?.llm?.enabled ? " · LLM" : ""}
        </span>
        {error && <span className="chip chip-error" title={error}>错误: {error}</span>}
      </div>
    </header>
  );
}
