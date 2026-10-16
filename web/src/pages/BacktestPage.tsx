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
  /** 情景种子：留空 = 每次掷新路径；填数字 = 沿用那一条（复现） */
  const [seedText, setSeedText] = useState("");
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
  // 模拟交易所 = 随机行情。结果必须自己先说清楚，不能让用户拿去当证据。
  const simulatedConnection =
    connections.find((c) => c.id === connectionId)?.adapterId === "simulated";

  // 非法种子宁可不认也不假装在复现：这里明确说"会按随机跑"，
  // 而不是静默丢掉输入 —— 否则用户以为在同一条路上核对，其实换了条路。
  const seedInput = seedText.trim();
  const seedOk = seedInput === "" || (Number.isInteger(Number(seedInput)) && Number(seedInput) >= 0);

  const run = async () => {
    if (!connectionId || symbols.length === 0 || !strategyId) return;
    setBusy(true);
    setErr(null);
    try {
      const seed = seedText.trim() === "" ? undefined : Number(seedText.trim());
      const r = await api.runBacktest({
        connectionId,
        symbols,
        strategyId,
        interval,
        barCount,
        initialCash: cash,
        // 种子非法就当没填：宁可在新路径上跑，也不要假装在复现
        ...(seed !== undefined && Number.isInteger(seed) && seed >= 0 ? { scenarioSeed: seed } : {}),
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
        subtitle="把一段历史行情灌进策略，看它的战绩。与机器人无关，也不影响任何机器人的统计"
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

          {simulatedConnection && (
            <Notice tone="warn">
              当前连接是「模拟交易所」：<b>每跑一次都掷一条新的随机行情路径</b>，
              所以两次回测的数字不会一样 —— 这是刻意的，同一条路重跑只能证明"那条路上赚过钱"。
              随机行情 + 规则的结果只是随机数与规则的产物，<b>不构成策略表现的任何证据</b>；
              它的用途是看策略换条路还行不行。想看可信结果，请换用已连通的真实行情连接。
              <div className="small" style={{ marginTop: 4 }}>
                周期越短随机行情越安静：1m 常常几百根都不出一个信号（那不是策略坏了，是这个周期的波动本来就这么小）。
                想看它做决策，请用 4h 或 1d。
              </div>
            </Notice>
          )}
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
          {simulatedConnection && (
            <div className="field-row small" style={{ marginTop: 8 }}>
              <label htmlFor="bt-seed">情景种子</label>
              <input
                id="bt-seed"
                className="input"
                style={{ width: 140 }}
                inputMode="numeric"
                placeholder="留空 = 每次随机"
                value={seedText}
                onChange={(e) => setSeedText(e.target.value)}
                title="模拟行情每次都会掷一条新的随机路径。想把某一次结果原样重跑，把当时显示的种子填到这里。"
              />
              <span className="dim">
                {result?.scenarioSeed !== undefined ? (
                  <>
                    上次用的种子 <b>{result.scenarioSeed}</b>
                  </>
                ) : (
                  "每次结果都不同才看得出策略稳不稳"
                )}
              </span>
              {!seedOk && (
                <Notice tone="warn">
                  「{seedInput}」不是合法种子（要 0 或正整数）：这次会按<b>每次随机</b>跑，不是在复现。
                </Notice>
              )}
            </div>
          )}
          {err && <div className="bot-error">{err}</div>}
        </div>
      </Panel>

      {result && (
        <Panel
          title={`回测结果 · ${result.strategyName}`}
          subtitle={`${result.symbols.join(" / ")} · ${result.interval} · ${result.bars} 根 · 耗时 ${(result.durationMs / 1000).toFixed(1)}s`}
        >
          {result.marketData === "simulated" ? (
            <Notice tone="error">
              这份结果跑在<b>随机生成的行情</b>上（{result.connectionLabel ?? "模拟交易所"}），
              不代表策略在真实市场的表现，别拿它做决策。换成真实行情连接再跑一次。
              <div className="small" style={{ marginTop: 4 }}>
                本次情景种子 <b>{result.scenarioSeed ?? "—"}</b>：再点一次「开始回测」会换一条新路径，
                数字自然不同；想让这一次原样重现，才把这个种子用回去。
              </div>
            </Notice>
          ) : (
            <Notice tone="success">
              行情来自 {result.connectionLabel ?? "真实数据源"}；成交按<b>决策的下一根 K 线开盘价</b>模拟，
              已计手续费与滑点 —— 策略看不到还没发生的那一段。
            </Notice>
          )}
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
            成交口径与机器人一致：信号在这根 K 线的收盘算出，成交按<b>下一根 K 线的开盘价</b>撮合，
            已计手续费与冲击滑点，所以它用不到自己成交那一刻之后的信息（跳空低开就按低开成交，不按收盘价凑）。
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
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <span className={`stat-value mono ${tone ?? ""}`}>{value}</span>
    </div>
  );
}

function describeSource(s: StrategyProfile): string {
  if (s.decisionSource === "rules") return s.selfAllocating ? "量化交易 · AI 选资产" : "量化交易 · 双均线";
  if (s.decisionSource === "hybrid") return "混合决策（不支持回测）";
  return `${s.decisionSource === "chat" ? "对话模型" : "决策模型"}（不支持回测）`;
}
