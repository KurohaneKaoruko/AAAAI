/**
 * 仪表盘：以**交易机器人**为主体。
 *
 * 之前这里摆的是"运行引擎"（单账户流水线）的指标、权益曲线、持仓与流水，
 * 于是产生一个很实际的误解：大家都改用机器人跑了，仪表盘却还是另一套数据 ——
 * 机器人跑起来的时候，这里的图表仍然是空的或旧的。
 *
 * 现在：
 * - 上半部分 = 机器人总览（数量、运行中、总权益、最好/最差）与选中机器人的曲线、持仓、流水
 * - 下半部分 = 单账户引擎（可实盘），默认折叠，并写清它和机器人的区别
 *   机器人始终模拟成交；只有单账户引擎能下真实订单。
 */

import { useEffect, useMemo, useState } from "react";
import type { AppStore } from "../state/useAppStore";
import { EquityChart } from "../components/EquityChart";
import { EventLog } from "../components/EventLog";
import { PositionsTable } from "../components/PositionsTable";
import { TradesTable } from "../components/TradesTable";
import { Button, Empty, Panel } from "../components/ui";
import type { Bot } from "../types";
import { dateTime, money, pct, time } from "../lib/format";

const STATUS: Record<string, { text: string; cls: string }> = {
  idle: { text: "待机", cls: "badge-idle" },
  running: { text: "运行中", cls: "badge-running" },
  stopped: { text: "已停止", cls: "badge-stopped" },
  error: { text: "异常", cls: "badge-error" },
};

export function DashboardPage({ store, onNavigate }: { store: AppStore; onNavigate?: (page: "bots" | "strategy") => void }) {
  const state = store.state;
  const [bots, setBots] = useState<Bot[]>([]);
  const [selectedBot, setSelectedBot] = useState<string>("");
  const [tab, setTab] = useState<"positions" | "trades" | "events">("positions");

  // 机器人状态本来就在交易机器人页轮询；这里同样轮询，保证两个页面看到的是同一份数据
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await fetch("/api/bots").then((r) => r.json());
        if (alive && Array.isArray(d.bots)) setBots(d.bots);
      } catch {
        /* 服务不可用时保持原样 */
      }
    };
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const withData = useMemo(() => bots.filter((b) => b.state.metrics), [bots]);
  const selected = useMemo(
    () => bots.find((b) => b.id === selectedBot) ?? withData[0] ?? bots[0],
    [bots, withData, selectedBot],
  );

  if (!state) return <div className="loading">正在连接 AAAAI 服务…</div>;

  const runningCount = bots.filter((b) => b.state.status === "running").length;
  const totalEquity = withData.reduce((a, b) => a + (b.state.metrics?.finalEquity ?? 0), 0);
  const returns = withData.map((b) => ({ b, r: b.state.metrics?.totalReturn ?? 0 }));
  const best = returns.length > 0 ? returns.reduce((a, c) => (c.r > a.r ? c : a)) : null;
  const worst = returns.length > 0 ? returns.reduce((a, c) => (c.r < a.r ? c : a)) : null;
  // 所有机器人都一样时，"最好/最差"指向同一个名字反而误导，直接说持平
  const allEqual = returns.length > 1 && returns.every((x) => Math.abs(x.r - returns[0]!.r) < 1e-12);

  return (
    <div className="page page-dashboard">
      <Panel
        title="交易机器人"
        subtitle={
          bots.length === 0
            ? "还没有机器人"
            : `${bots.length} 个机器人 · ${runningCount} 个运行中${withData.length > 0 ? ` · ${withData.length} 个有结果` : ""}`
        }
        actions={
          onNavigate ? (
            <Button small onClick={() => onNavigate("bots")}>
              管理机器人 →
            </Button>
          ) : undefined
        }
      >
        {bots.length === 0 ? (
          <Empty>
            还没有机器人。到「交易机器人」新建一个：它有自己的标的、策略、模型和资金，可并行运行，成交为本地模拟。
          </Empty>
        ) : (
          <>
            <div className="cards">
              <div className="card">
                <div className="card-label">总权益（各机器人合计）</div>
                <div className="card-value">{withData.length > 0 ? money(totalEquity) : "—"}</div>
              </div>
              <div className="card">
                <div className="card-label">运行中</div>
                <div className="card-value">{runningCount}</div>
              </div>
              <div className="card">
                <div className="card-label">最好</div>
                <div className={`card-value ${best && best.r >= 0 ? "up" : "down"}`}>
                  {best ? (allEqual ? "持平" : `${best.b.name} ${pct(best.r)}`) : "—"}
                </div>
              </div>
              <div className="card">
                <div className="card-label">最差</div>
                <div className={`card-value ${worst && worst.r < 0 ? "down" : "up"}`}>
                  {worst ? (allEqual ? "持平" : `${worst.b.name} ${pct(worst.r)}`) : "—"}
                </div>
              </div>
            </div>

            {bots.length > 1 && (
              <div className="chip-row" style={{ marginTop: 12 }}>
                {bots.map((b) => {
                  const st = STATUS[b.state.status] ?? STATUS.idle!;
                  const on = selected?.id === b.id;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      className={`chip ${on ? "chip-accent" : ""}`}
                      onClick={() => setSelectedBot(b.id)}
                      title={`${b.name} · ${st.text}`}
                    >
                      {b.name}
                      <span className={`badge ${st.cls}`} style={{ marginLeft: 6 }}>
                        {st.text}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </Panel>

      {selected && (
        <div className="grid-dash">
          <div className="col">
            <Panel title="组合明细" subtitle={selected.state.startedAt ? `开始于 ${dateTime(selected.state.startedAt)}` : undefined}>
              <div className="tabs">
                <button
                  type="button"
                  className={`tab ${tab === "positions" ? "tab-on" : ""}`}
                  onClick={() => setTab("positions")}
                >
                  持仓 {selected.state.allocation?.heldCount ?? 0}
                </button>
                <button
                  type="button"
                  className={`tab ${tab === "trades" ? "tab-on" : ""}`}
                  onClick={() => setTab("trades")}
                >
                  成交 {selected.state.metrics?.totalFills ?? 0}
                </button>
                <button
                  type="button"
                  className={`tab ${tab === "events" ? "tab-on" : ""}`}
                  onClick={() => setTab("events")}
                >
                  事件 {selected.state.events.length}
                </button>
              </div>
              {selected.state.error ? (
                <div className="notice notice-error">运行出错：{selected.state.error}</div>
              ) : tab === "positions" ? (
                <BotPositions bot={selected} />
              ) : tab === "trades" ? (
                <BotTrades bot={selected} />
              ) : (
                <BotEvents bot={selected} />
              )}
            </Panel>
          </div>

          <div className="col">
            <Panel title="权益曲线" subtitle={selected.symbols.join(" / ")}>
              {selected.state.equityCurve.length > 1 ? (
                <EquityChart curve={selected.state.equityCurve} initialCash={selected.risk.initialCash} />
              ) : (
                <Empty>还没有权益数据 —— 点「管理机器人」里的「启动」跑一次</Empty>
              )}
            </Panel>
          </div>
        </div>
      )}

    </div>
  );
}

/** 机器人持仓：用它自己的资产配置视图（与交易机器人页一致）。 */
function BotPositions({ bot }: { bot: Bot }) {
  const a = bot.state.allocation;
  if (!a || a.holdings.length === 0) {
    return <div className="dim small">当前全部现金 —— 尚未建仓</div>;
  }
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>标的</th>
            <th className="num">数量</th>
            <th className="num">均价</th>
            <th className="num">现价</th>
            <th className="num">市值</th>
            <th className="num">权重</th>
            <th className="num">浮动盈亏</th>
          </tr>
        </thead>
        <tbody>
          {a.holdings.map((h) => (
            <tr key={h.symbol}>
              <td className="mono">{h.symbol}</td>
              <td className="num mono">{h.quantity.toFixed(6)}</td>
              <td className="num mono">{money(h.avgCost, h.avgCost > 100 ? 2 : 4)}</td>
              <td className="num mono">{money(h.price, h.price > 100 ? 2 : 4)}</td>
              <td className="num mono">{money(h.marketValue)}</td>
              <td className="num mono">{pct(h.weight)}</td>
              <td className={`num mono ${h.unrealizedPnl >= 0 ? "up" : "down"}`}>
                {h.unrealizedPnl >= 0 ? "+" : ""}
                {money(h.unrealizedPnl)}
              </td>
            </tr>
          ))}
          <tr>
            <td>现金</td>
            <td className="num mono" colSpan={3}>
              {money(a.cash)}
            </td>
            <td className="num mono">{pct(a.cashWeight)}</td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** 机器人成交：机器人侧只保留汇总，明细到该机器人自己的视图里看。 */
function BotTrades({ bot }: { bot: Bot }) {
  const m = bot.state.metrics;
  if (!m) return <div className="dim small">尚未产生数据 —— 点「管理机器人」里的「启动」开始</div>;
  return (
    <div className="cards">
      <div className="card">
        <div className="card-label">权益</div>
        <div className="card-value">{money(m.finalEquity)}</div>
      </div>
      <div className="card">
        <div className="card-label">收益率</div>
        <div className={`card-value ${m.totalReturn >= 0 ? "up" : "down"}`}>{pct(m.totalReturn)}</div>
      </div>
      <div className="card">
        <div className="card-label">成交笔数</div>
        <div className="card-value">{m.totalFills}</div>
      </div>
      <div className="card">
        <div className="card-label">最大回撤</div>
        <div className={`card-value ${m.maxDrawdownPct > 0.1 ? "down" : ""}`}>{pct(m.maxDrawdownPct)}</div>
      </div>
      <div className="card">
        <div className="card-label">已实现盈亏</div>
        <div className={`card-value ${m.realizedPnl >= 0 ? "up" : "down"}`}>{money(m.realizedPnl)}</div>
      </div>
      <div className="card">
        <div className="card-label">持仓数</div>
        <div className="card-value">{m.openPositions}</div>
      </div>
    </div>
  );
}

function BotEvents({ bot }: { bot: Bot }) {
  if (bot.state.events.length === 0) return <div className="dim small">暂无事件</div>;
  return (
    <EventLog
      events={bot.state.events.map((e, i) => ({
        seq: i + 1,
        timestamp: e.timestamp,
        topic: e.topic,
        summary: e.summary,
      }))}
    />
  );
}

export { time };