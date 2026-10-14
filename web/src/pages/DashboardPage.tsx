/** 仪表盘：运行控制 + 指标 + 权益曲线 + 持仓 + 流水 + 事件流。 */

import { useState } from "react";
import type { AppStore } from "../state/useAppStore";
import { EquityChart } from "../components/EquityChart";
import { EventLog } from "../components/EventLog";
import { PositionsTable } from "../components/PositionsTable";
import { RunControls } from "../components/RunControls";
import { TradesTable } from "../components/TradesTable";
import { Panel } from "../components/ui";
import { dateTime, money, pct } from "../components/../lib/format";

export function DashboardPage({ store }: { store: AppStore }) {
  const state = store.state;
  const [tab, setTab] = useState<"positions" | "trades" | "events">("positions");
  const metrics = state?.metrics;
  const initialCash = state?.config?.risk?.initialCash ?? 0;
  const equity = metrics?.finalEquity ?? initialCash;
  const pnl = equity - initialCash;

  if (!state) return <div className="loading">正在连接 AAAAI 服务…</div>;

  const cards = [
    { label: "总权益", value: metrics ? money(equity) : "—", tone: pnl >= 0 ? "up" : "down" },
    {
      label: "浮动盈亏",
      value: metrics ? `${pnl >= 0 ? "+" : ""}${money(pnl)}（${initialCash > 0 ? pct(pnl / initialCash) : "—"}）` : "—",
      tone: pnl >= 0 ? "up" : "down",
    },
    { label: "已实现盈亏", value: money(state.realizedPnl), tone: state.realizedPnl >= 0 ? "up" : "down" },
    { label: "可用现金", value: metrics ? money(metrics.cash) : "—" },
    { label: "最大回撤", value: metrics ? pct(metrics.maxDrawdownPct) : "—", tone: (metrics?.maxDrawdownPct ?? 0) > 0.1 ? "down" : undefined },
    { label: "成交笔数", value: metrics ? String(metrics.totalFills) : "—" },
  ];

  return (
    <div className="page page-dashboard">
      <div className="grid-dash">
        <div className="col">
          <Panel title="运行引擎" subtitle={`开始时间 ${dateTime(state.startedAt)}`}>
            <RunControls store={store} />
          </Panel>
          <Panel title="关键指标">
            <div className="cards">
              {cards.map((c) => (
                <div className="card" key={c.label}>
                  <div className="card-label">{c.label}</div>
                  <div className={`card-value ${c.tone ?? ""}`}>{c.value}</div>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <div className="col">
          {state.error && (
            <div className="notice notice-error">
              运行出错：{state.error}
            </div>
          )}
          <Panel title="权益曲线" subtitle={state.symbols.length > 0 ? state.symbols.join(" / ") : ""}>
            <EquityChart curve={state.equityCurve} initialCash={initialCash} />
          </Panel>
        </div>
      </div>

      <Panel
        title="组合明细"
        actions={
          <div className="tabs">
            <button type="button" className={`tab ${tab === "positions" ? "tab-on" : ""}`} onClick={() => setTab("positions")}>
              持仓 {state.positions.length}
            </button>
            <button type="button" className={`tab ${tab === "trades" ? "tab-on" : ""}`} onClick={() => setTab("trades")}>
              成交 {state.trades.length}
            </button>
            <button type="button" className={`tab ${tab === "events" ? "tab-on" : ""}`} onClick={() => setTab("events")}>
              事件流
            </button>
          </div>
        }
      >
        {tab === "positions" && <PositionsTable positions={state.positions} prices={state.prices} equity={equity} />}
        {tab === "trades" && <TradesTable trades={state.trades} />}
        {tab === "events" && <EventLog events={store.events} />}
      </Panel>
    </div>
  );
}