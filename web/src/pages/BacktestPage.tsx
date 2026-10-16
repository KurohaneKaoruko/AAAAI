/**
 * 历史模拟（回测）页。
 *
 * 与机器人的分工写在这里，免得混：
 * - 机器人是实时实体。决策来自实时行情、成交随实时 K 线产生、统计就是它的实时操作。
 *   「一启动就几十笔成交」不会出现：预热只喂指标，成交从下一根实时 K 线开始。
 * - 本页专门回放历史：把一段时间的历史行情灌进流水线，看这套策略参数跑出来什么战绩。
 *   成交当然一次性全出 —— 这就是它该做的事，它不属于任何机器人，也不写机器人的统计。
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useAppStore, type AppStore } from "../state/useAppStore";
import { Button, Empty, Notice, NumberField, Panel, SelectField } from "../components/ui";
import { EquityChart } from "../components/EquityChart";
import { TradesTable } from "../components/TradesTable";
import { money, pct, signed } from "../lib/format";
import type { BacktestResult, Connection, StrategyProfile, WatchItem } from "../types";

const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"];

export function BacktestPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [strategies, setStrategies] = useState<StrategyProfile[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [symbols, setSymbols] = useState<string[]>([]);
  const [strategyId, setStrategyId] = useState("");
  const [interval, setInterval] = useState("1d");
  const [barCount, setBarCount] = useState(200);
  const [cash, setCash] = useState(100000);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, w, s] = await Promise.all([api.connections(), api.watchlist(), api.strategies()]);
      setConnections(c.connections);
      setWatchlist(w.items);
      setStrategies(s.strategies);
      if (!connectionId && c.connections.length > 0) setConnectionId(c.connections[0]!.id);
      if (!strategyId && s.strategies.length > 0) setStrategyId(s.strategies[0]!.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [connectionId, strategyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const connSymbols = watchlist.filter((w) => w.connectionId === connectionId).map((w) => w.symbol);
  const strategy = strategies.find((s) => s.id === strategyId);
  const local = strategy ? strategy.decisionSource === "rules" : true;

  const run = async () => {
    if (!connectionId || symbols.length === 0 || !strategyId) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.runBacktest({
        connectionId,
        symbols,
        strategyId,
        interval,
        barCount,
        initialCash: cash,
      });
      setResult(r.result);
    } catch (e) {
      setErr((e as Error).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page page-backtest">
      <Panel
        title="历史模拟（回测）"
        subtitle="把一段真实历史行情灌进策略，看它的战绩。与机器人无关，也不影响任何机器人的统计"
      >
        <div className="connection-form">
          <div className="grid-2">
            <SelectField
              label="行情连接"
              value={connectionId}
              options={connections.map((c) => ({ value: c.id, label: c.label }))}
              onChange={(v) => {
                setConnectionId(v);
                setSymbols([]);
              }}
            />
            <SelectField
              label="策略"
              value={strategyId}
              options={strategies.map((s) => ({ value: s.id, label: `${s.name} · ${describeSource(s)}` }))}
              onChange={setStrategyId}
            />
          </div>

          {strategy && !local && (
            <Notice tone="warn">
              策略「{strategy.name}」的决策来源是
              {strategy.decisionSource === "hybrid" ? "混合决策（要调两个模型）" : "大模型"}，
              回测不支持：模型有延迟与费用，且回放里问模型等于用后见之明，历史成绩会虚高。
              量化交易策略可在此回测；模型对比请用「模拟对照」页。
            </Notice>
          )}

          <div className="grid-3">
            <SelectField
              label="K 线周期"
              value={interval}
              options={INTERVALS.map((i) => ({ value: i, label: i }))}
              onChange={setInterval}
            />
            <NumberField label="K 线数量" value={barCount} step={20} min={20} max={1000} onChange={setBarCount} />
            <NumberField label="初始资金" value={cash} step={1000} min={100} onChange={setCash} />
          </div>

          <div className="symbol-picker">
            <div className="symbol-picker-head">回测标的（可多选）</div>
            <div className="chip-row">
              {[...new Set(connSymbols)].map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`symbol-chip ${symbols.includes(s) ? "symbol-on" : ""}`}
                  onClick={() =>
                    setSymbols((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))
                  }
                >
                  {s}
                </button>
              ))}
            </div>
            {connSymbols.length === 0 && (
              <span className="dim small">该连接的候选池为空，请先到「策略 → 候选池」添加</span>
            )}
            {connSymbols.length > 0 && symbols.length === 0 && (
              <span className="dim small">还没选标的 —— 点上面的代码即可选中</span>
            )}
          </div>

          <div className="btn-row btn-row-auto">
            <Button
              variant="primary"
              onClick={run}
              busy={busy}
              disabled={!connectionId || symbols.length === 0 || !strategyId || !local}
              title={
                !local
                  ? "该策略的决策来源是大模型：回放里问模型等于用后见之明，请用「模拟对照」"
                  : symbols.length === 0
                    ? "先选至少一个标的"
                    : undefined
              }
            >
              {busy ? "回测中…" : "开始回测"}
            </Button>
            {symbols.length === 0 && <span className="dim small">先选至少一个标的</span>}
            {!local && <span className="dim small">该策略的决策来源不支持回测</span>}
          </div>
          {err && <div className="bot-error">{err}</div>}
        </div>
      </Panel>

      {result && (
        <Panel title={`回测结果 · ${result.strategyName}`} subtitle={`${result.symbols.join(" / ")} · ${result.interval} · ${result.bars} 根 · 耗时 ${(result.durationMs / 1000).toFixed(1)}s`}>
          <div className="grid-4">
            <Stat label="期末权益" value={money(result.metrics.finalEquity, 2)} tone={result.metrics.totalReturn >= 0 ? "up" : "down"} />
            <Stat label="收益率" value={signed(result.metrics.totalReturn * 100) + "%"} tone={result.metrics.totalReturn >= 0 ? "up" : "down"} />
            <Stat label="已实现盈亏" value={signed(result.metrics.realizedPnl)} tone={result.metrics.realizedPnl >= 0 ? "up" : "down"} />
            <Stat label="成交笔数" value={String(result.metrics.totalFills)} />
            <Stat label="最大回撤" value={pct(result.metrics.maxDrawdownPct)} />
            <Stat label="期末持仓" value={String(result.metrics.openPositions)} />
          </div>

          {result.equityCurve.length > 1 && (
            <div style={{ marginTop: 12 }}>
              <EquityChart curve={result.equityCurve} initialCash={cash} />
            </div>
          )}

          {result.pnlBySymbol.length > 0 && (
            <table className="table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>标的</th>
                  <th className="num">已实现盈亏</th>
                  <th className="num">成交笔数</th>
                </tr>
              </thead>
              <tbody>
                {result.pnlBySymbol.map((p) => (
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
          )}

          {result.metrics.totalFills === 0 && (
            <Notice tone="info">这段时间里策略没有触发任何成交（可能全程空仓信号或风控拦截）。</Notice>
          )}

          <div style={{ marginTop: 12 }}>
            <h4 className="dim">成交流水</h4>
            <TradesTable trades={result.trades} />
          </div>

          <div className="dim small" style={{ marginTop: 10 }}>
            注意：回测成交按收盘价一次性撮合，不含滑点外的时点差异，也不含未来数据——
            历史成绩不代表未来收益，别把它当成收益承诺。
            要验证「策略在实时行情下会怎么操作」，请去看交易机器人的「操作指引」。
          </div>
        </Panel>
      )}

      {!result && !busy && (
        <Panel title="怎么用">
          <Empty>
            选好连接、策略与标的后点「开始回测」。结果只在本页显示，不写机器人的任何统计 ——
            机器人只根据实时行情跑，这里专门回答「这套参数在那段历史里行不行」。
          </Empty>
        </Panel>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="stat-card">
      <span className="dim small">{label}</span>
      <b className={`mono ${tone ?? ""}`}>{value}</b>
    </div>
  );
}

function describeSource(s: StrategyProfile): string {
  if (s.decisionSource === "rules") return s.selfAllocating ? "量化交易 · AI 选资产" : "量化交易 · 双均线";
  if (s.decisionSource === "hybrid") return "混合决策（不支持回测）";
  return `${s.decisionSource === "chat" ? "对话模型" : "决策模型"}（不支持回测）`;
}
