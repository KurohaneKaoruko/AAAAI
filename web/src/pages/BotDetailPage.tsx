/**
 * 机器人详情页：把一台机器人的全部信息摊在一屏里。
 *
 * 为什么要单独一页：卡片只该用来扫一眼（现在跑没跑、赚没赚、该不该看）。
 * 持仓、收益曲线、逐笔成交、历史战绩、事件流水这些要看清的东西塞进折叠块里，
 * 结果就是全都藏起来、谁也不看 —— 所以拆出来，按"先结论后明细"排。
 *
 * 数据全部来自服务端；本页只做排版与展示，不自己推导任何数字。
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Button, Empty, Panel } from "../components/ui";
import { describe } from "../components/StrategyProfiles";
import { EquityChart } from "../components/EquityChart";
import { money, pct, qty, signed, time, wPct, dateTime, TOPIC_LABEL } from "../lib/format";
import type { Bot, BotAction, StrategyProfile } from "../types";

const STATUS: Record<string, { text: string; cls: string }> = {
  idle: { text: "待机", cls: "badge-idle" },
  running: { text: "运行中", cls: "badge-running" },
  stopped: { text: "已停止", cls: "badge-stopped" },
  error: { text: "异常", cls: "badge-error" },
};

export function BotDetailPage({
  botId,
  onBack,
  onStart,
  onStop,
  onEdit,
}: {
  botId: string;
  onBack: () => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onEdit: (id: string) => void;
}) {
  const [bot, setBot] = useState<Bot | null>(null);
  const [strategies, setStrategies] = useState<StrategyProfile[]>([]);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const { bots } = await api.bots();
      const found = bots.find((b) => b.id === botId) ?? null;
      setBot(found);
      setMissing(!found);
    } catch {
      /* 轮询失败就等下一轮，不打断阅读 */
    }
  }, [botId]);

  useEffect(() => {
    void reload();
    void api.strategies().then((s) => setStrategies(s.strategies)).catch(() => undefined);
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [reload]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
    } finally {
      setBusy(false);
    }
  };

  if (missing) {
    return (
      <div className="page page-bots">
        <Panel title="机器人详情">
          <Empty>这个机器人已不存在（可能刚被删除）。</Empty>
          <div style={{ marginTop: 10 }}>
            <Button onClick={onBack}>返回机器人列表</Button>
          </div>
        </Panel>
      </div>
    );
  }

  if (!bot) {
    return (
      <div className="page page-bots">
        <Panel title="机器人详情">
          <Empty>正在加载…</Empty>
        </Panel>
      </div>
    );
  }

  const st = bot.state;
  const m = st.metrics;
  const a = st.allocation;
  const running = st.status === "running";
  const status = STATUS[st.status] ?? STATUS.idle!;

  return (
    <div className="page page-bots">
      <Panel
        title={bot.name}
        subtitle={
          <span className="bot-chips">
            <span className={`badge ${status.cls}`}>{status.text}</span>
            <span className="chip chip-sm">持续运行</span>
            {bot.paperTrading ? (
              <span className="chip chip-sm">模拟成交</span>
            ) : st.liveTrading ? (
              <span className={`chip chip-sm ${running ? "chip-live" : "chip-off"}`}>
                {running ? "实盘下单中" : "上次运行为实盘"}
              </span>
            ) : (
              <span className="chip chip-sm chip-off">真实下单（未运行）</span>
            )}
            <span className="chip chip-sm">{bot.interval}</span>
          </span>
        }
        actions={
          <div className="btn-row btn-row-auto">
            <Button small variant="primary" busy={busy} disabled={running} onClick={() => void run(() => api.startBot(bot.id))}>
              {running ? "运行中" : "启动"}
            </Button>
            <Button small variant="danger" disabled={!running} onClick={() => void run(() => api.stopBot(bot.id))}>
              停止
            </Button>
            <Button small onClick={() => onEdit(bot.id)}>
              编辑
            </Button>
            <Button small variant="ghost" onClick={onBack}>
              返回列表
            </Button>
          </div>
        }
      >
        {st.error && <div className="bot-error">{st.error}</div>}
        <div className="bot-meta">
          <span>
            <em>标的</em> <b className="mono">{bot.symbols.join(" / ")}</b>
          </span>
          <span>
            <em>决策</em> <b>{bot.modelLabels.join(" / ") || "—"}</b>
          </span>
          <span>
            <em>策略</em>{" "}
            <b className="mono">
              {(() => {
                const sp = strategies.find((x) => x.id === bot.strategyId);
                // 引用失效（策略被删）时要如实说明，不能拿旧参数糊过去
                if (bot.strategyId && !sp) return `${bot.strategyId}（已失效）`;
                return sp ? describe(sp) : "—";
              })()}
            </b>
          </span>
          <span>
            <em>资金</em> <b className="mono">{money(bot.risk.initialCash, 0)}</b>
          </span>
          <span>
            <em>启动于</em> <b className="mono">{dateTime(st.startedAt)}</b>
          </span>
          <span>
            <em>运行时长</em> <b className="mono">{(st.durationMs / 1000).toFixed(0)}s</b>
          </span>
          <span>
            <em>实时 K 线</em> <b className="mono">{st.bars}</b>
          </span>
          <span>
            <em>预热 K 线</em> <b className="mono">{st.warmupBars}</b>
          </span>
        </div>
      </Panel>

      <Panel title="战绩" subtitle="只统计实时收到的 K 线；预热历史只喂指标，不产生成交">
        <div className="grid-4">
          <Stat label="权益" value={m ? money(m.finalEquity) : "—"} tone={(m?.totalReturn ?? 0) >= 0 ? "up" : "down"} />
          <Stat label="收益率" value={m ? `${signed(m.totalReturn * 100)}%` : "—"} tone={(m?.totalReturn ?? 0) >= 0 ? "up" : "down"} />
          <Stat label="已实现盈亏" value={m ? signed(m.realizedPnl) : "—"} tone={(m?.realizedPnl ?? 0) >= 0 ? "up" : "down"} />
          <Stat label="浮动盈亏" value={a ? signed(a.holdings.reduce((s, h) => s + h.unrealizedPnl, 0)) : "—"} tone={a && a.holdings.reduce((s, h) => s + h.unrealizedPnl, 0) >= 0 ? "up" : "down"} />
          <Stat label="成交笔数" value={m ? String(m.totalFills) : "—"} />
          <Stat label="持仓数" value={m ? String(m.openPositions) : "—"} />
          <Stat label="最大回撤" value={m ? pct(m.maxDrawdownPct) : "—"} />
          <Stat label="现金" value={a ? money(a.cash) : "—"} />
        </div>
        {st.equityCurve.length > 1 && (
          <div style={{ marginTop: 12 }}>
            <EquityChart curve={st.equityCurve} initialCash={bot.risk.initialCash} />
          </div>
        )}
        {st.equityCurve.length <= 1 && (
          <div className="dim small" style={{ marginTop: 8 }}>
            还没有权益曲线 —— 曲线来自实时成交，每来一根新 K 线才可能有变化。
          </div>
        )}
      </Panel>

      <ActionPanel bot={bot} />

      <Panel title="当前持仓" subtitle={a ? `权益 ${money(a.equity)} · 现金 ${wPct(a.cashWeight)}` : "尚未产生配置"}>
        {a && a.holdings.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>标的</th>
                  <th className="num">数量</th>
                  <th className="num">成本价</th>
                  <th className="num">现价</th>
                  <th className="num">市值</th>
                  <th className="num">权重</th>
                  <th className="num">浮动盈亏</th>
                </tr>
              </thead>
              <tbody>
                {a.holdings.map((h) => (
                  <tr key={h.symbol}>
                    <td className="mono strong">{h.symbol}</td>
                    <td className="mono num">{qty(h.quantity)}</td>
                    <td className="mono num">{money(h.avgCost, 4)}</td>
                    <td className="mono num">{money(h.price, 4)}</td>
                    <td className="mono num">{money(h.marketValue)}</td>
                    <td className="mono num">{wPct(h.weight)}</td>
                    <td className={`mono num ${h.unrealizedPnl >= 0 ? "up" : "down"}`}>{signed(h.unrealizedPnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="alloc-empty">
            <b className="mono">{money(a?.equity ?? 0)}</b>
            <span className="dim">全部为现金，暂无持仓</span>
          </div>
        )}
      </Panel>

      <Panel
        title="成交流水"
        subtitle={
          st.trades.length < (m?.totalFills ?? 0)
            ? `最近 ${st.trades.length} 笔 / 共 ${m?.totalFills} 笔`
            : `共 ${st.trades.length} 笔`
        }
      >
        {st.trades.length > 0 ? (
          <div className="table-scroll table-scroll-tall">
            <table className="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>方向</th>
                  <th>标的</th>
                  <th className="num">数量</th>
                  <th className="num">成交价</th>
                  <th className="num">手续费</th>
                  <th className="num">已实现盈亏</th>
                  <th>决策理由</th>
                </tr>
              </thead>
              <tbody>
                {st.trades.map((t) => (
                  <tr key={t.id}>
                    <td className="mono dim">{time(t.timestamp)}</td>
                    <td>
                      <span className={`side-tag ${t.side === "BUY" ? "side-buy" : "side-sell"}`}>
                        {t.side === "BUY" ? "买入" : "卖出"}
                      </span>
                    </td>
                    <td className="mono strong">{t.symbol}</td>
                    <td className="mono num">{qty(t.quantity)}</td>
                    <td className="mono num">{money(t.price, 4)}</td>
                    <td className="mono num dim">{money(t.fee, 4)}</td>
                    <td className={`mono num ${t.realizedPnl > 0 ? "up" : t.realizedPnl < 0 ? "down" : "dim"}`}>
                      {t.realizedPnl === 0 ? "—" : signed(t.realizedPnl)}
                    </td>
                    <td className="dim small">{t.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>还没有成交 —— 成交随实时 K 线到来产生，不是启动时补的。</Empty>
        )}
      </Panel>

      {st.pnlBySymbol.length > 0 && (
        <Panel title="分标的盈亏">
          <table className="table">
            <thead>
              <tr>
                <th>标的</th>
                <th className="num">已实现盈亏</th>
                <th className="num">成交笔数</th>
              </tr>
            </thead>
            <tbody>
              {st.pnlBySymbol.map((p) => (
                <tr key={p.symbol}>
                  <td className="mono strong">{p.symbol}</td>
                  <td className={`num mono ${p.realizedPnl > 0 ? "up" : p.realizedPnl < 0 ? "down" : "dim"}`}>
                    {p.realizedPnl === 0 ? "—" : signed(p.realizedPnl)}
                  </td>
                  <td className="num mono">{p.fills}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel
        title="历史战绩"
        subtitle={`${bot.totals.runs} 次运行 · 盈利 ${bot.totals.wins} / 亏损 ${bot.totals.losses} · 累计已实现 ${signed(bot.totals.cumulativeRealizedPnl)}`}
      >
        <div className="dim small" style={{ marginBottom: 8 }}>
          每次运行都从初始资金 {money(bot.risk.initialCash, 0)} 重新开始，累计为各次已实现盈亏之和，不是复利累计；
          汇总只计正常结束的运行。
        </div>
        {bot.history.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>开始时间</th>
                  <th>方式</th>
                  <th>状态</th>
                  <th className="num">收益</th>
                  <th className="num">成交</th>
                  <th className="num">已实现盈亏</th>
                  <th className="num">时长</th>
                </tr>
              </thead>
              <tbody>
                {bot.history.map((r) => {
                  const ret = r.metrics?.totalReturn ?? 0;
                  return (
                    <tr key={r.id}>
                      <td className="mono dim">{dateTime(r.startedAt)}</td>
                      <td className="dim">{r.liveTrading ? "实时 · 真实下单" : "实时 · 模拟成交"}</td>
                      <td>
                        {r.status === "stopped" ? (
                          <span className="dim">已停止</span>
                        ) : r.status === "running" ? (
                          <span className="chip chip-sm chip-ok">运行中</span>
                        ) : (
                          <span className="chip chip-sm chip-off" title={r.error ?? ""}>
                            出错
                          </span>
                        )}
                      </td>
                      <td className={`num mono ${ret > 0 ? "up" : ret < 0 ? "down" : "dim"}`}>
                        {r.metrics ? `${signed(ret * 100)}%` : "—"}
                      </td>
                      <td className="num mono">{r.metrics ? r.metrics.totalFills : "—"}</td>
                      <td className={`num mono ${(r.metrics?.realizedPnl ?? 0) >= 0 ? "up" : "down"}`}>
                        {r.metrics ? signed(r.metrics.realizedPnl) : "—"}
                      </td>
                      <td className="num mono dim">{(r.durationMs / 1000).toFixed(0)}s</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>还没有运行记录。</Empty>
        )}
      </Panel>

      <Panel title="事件" subtitle={st.events.length > 0 ? `最近 ${st.events.length} 条` : undefined}>
        {st.events.length > 0 ? (
          <div className="event-log" style={{ maxHeight: 420 }}>
            {st.events.map((e, i) => (
              <div className="event-row" key={`${e.timestamp}-${i}`}>
                <span className="event-time mono">{time(e.timestamp)}</span>
                <span className={`event-topic topic-${e.topic}`}>{TOPIC_LABEL[e.topic] ?? e.topic}</span>
                <span className="event-summary">{e.summary}</span>
              </div>
            ))}
          </div>
        ) : (
          <Empty>还没有事件 —— 事件来自实时行情带来的决策，预热期不产生。</Empty>
        )}
      </Panel>
    </div>
  );
}

/** 操作指引：目标仓位与实时持仓的差额，换算成买卖与数量。 */
function ActionPanel({ bot }: { bot: Bot }) {
  const st = bot.state;
  const a = st.allocation;
  const acts = st.actions.filter((x) => x.side !== "HOLD");
  const holds = st.actions.filter((x) => x.side === "HOLD" && x.note);
  return (
    <Panel
      title="操作指引"
      subtitle={a?.decidedAt ? `决策于 ${time(a.decidedAt)}` : "尚无决策"}
    >
      {acts.length > 0 && (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>操作</th>
                <th>标的</th>
                <th className="num">数量</th>
                <th className="num">参考价</th>
                <th className="num">金额</th>
                <th className="num">当前→目标</th>
                <th className="num">目标持仓</th>
              </tr>
            </thead>
            <tbody>
              {acts.map((x) => (
                <ActionRow key={x.symbol} a={x} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {acts.length === 0 && holds.length === 0 && (
        <Empty>还没有决策 —— 每来一根新的实时 K 线才会重新算一次。</Empty>
      )}
      {a?.reason && acts.length > 0 && (
        <div className="dim small" style={{ marginTop: 6 }}>
          理由：{a.reason}
        </div>
      )}
      {holds.map((x) => (
        <div key={x.symbol} className="dim small">
          {x.symbol} · {x.note}
        </div>
      ))}
      {acts.length > 0 && (
        <div className="dim small" style={{ marginTop: 6 }}>
          参考价为最新价，成交以实际下单为准；买入需按交易所最小单位取整。
        </div>
      )}
    </Panel>
  );
}

function ActionRow({ a }: { a: BotAction }) {
  return (
    <tr>
      <td>
        <span className={`side-tag ${a.side === "BUY" ? "side-buy" : "side-sell"}`}>
          {a.side === "BUY" ? "买入" : "卖出"}
        </span>
      </td>
      <td className="mono strong">{a.symbol}</td>
      <td className="mono num">{qty(a.quantity)}</td>
      <td className="mono num">{money(a.price, 4)}</td>
      <td className="mono num">{money(a.value, 2)}</td>
      <td className="num mono dim">
        {wPct(a.fromWeight)} → {wPct(a.toWeight)}
      </td>
      <td className="num mono dim">{qty(a.targetQty)}</td>
    </tr>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <span className={`stat-value mono ${tone ?? ""}`}>{value}</span>
    </div>
  );
}