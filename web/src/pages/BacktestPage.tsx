/**
 * 历史模拟（回测）页。
 *
 * 与机器人的分工写在这里，免得混：
 * - 机器人是实时实体。决策来自实时行情、成交随实时 K 线产生、统计就是它的实时操作。
 *   「一启动就几十笔成交」不会出现：预热只喂指标，成交从下一根实时 K 线开始。
 * - 本页专门回放历史：把一段时间的历史行情灌进流水线，看这套策略参数跑出来什么战绩。
 *   成交当然一次性全出 —— 这就是它该做的事，它不属于任何机器人，也不写机器人的统计。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Button, Empty, Notice, NumberField, Panel, SelectField } from "../components/ui";
import { EquityChart } from "../components/EquityChart";
import { KlineChart, type TradeMarker } from "../components/KlineChart";
import { Select } from "../components/Select";
import { Sparkline } from "../components/Sparkline";
import { TradesTable } from "../components/TradesTable";
import { money, pct, signed, signedPct } from "../lib/format";
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
  /** 盘面回放：当前显示的标的；多标的时由选择器切换 */
  const [chartSymbol, setChartSymbol] = useState("");
  const [showTrades, setShowTrades] = useState(true);
  const [loading, setLoading] = useState(true);

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
    } finally {
      setLoading(false);
    }
  }, [connectionId, strategyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const connSymbols = watchlist.filter((w) => w.connectionId === connectionId).map((w) => w.symbol);
  const strategy = strategies.find((s) => s.id === strategyId);
  const local = strategy ? strategy.decisionSource === "rules" : true;
  const selectedConnection = connections.find((c) => c.id === connectionId);
  const futuresConnection = selectedConnection?.tradingMode === "futures";

  const run = async () => {
    if (!connectionId || !strategyId || symbols.length === 0) return;
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

  useEffect(() => {
    setChartSymbol(result?.kline?.[0]?.symbol ?? "");
  }, [result]);

  const chart = result?.kline?.find((k) => k.symbol === chartSymbol) ?? result?.kline?.[0] ?? null;
  const chartTrades: TradeMarker[] = useMemo(() => {
    if (!chart) return [];
    return (result?.trades ?? [])
      .filter((t) => t.symbol === chart.symbol)
      .map((t) => ({
        id: t.id,
        timestamp: t.timestamp,
        side: t.side,
        price: t.price,
        quantity: t.quantity,
        reason: t.reason,
      }));
  }, [result, chart]);
  // 突破/均值回归的 fast/slow 语义不是均线，画 MA 会误导；只给趋势类画。
  const chartMa =
    result?.strategyParams &&
    (result.strategyParams.engine === "momentum" || result.strategyParams.engine === "adaptive")
      ? { fastWindow: result.strategyParams.fastWindow, slowWindow: result.strategyParams.slowWindow }
      : undefined;

  return (
    <div className="page page-backtest">
      <Panel
        title="历史模拟（回测）"
        subtitle="把一段历史行情灌进策略，看它的战绩。与机器人无关，也不影响任何机器人的统计"
      >
        <div className="connection-form">
          <div className="grid-2">
            <SelectField
              label="交易所连接"
              required
              value={connectionId}
              options={connections.map((c) => ({ value: c.id, label: c.label }))}
              onChange={(v) => {
                setConnectionId(v);
                setSymbols([]);
              }}
            />
            <SelectField
              label="策略"
              required
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
              <span className="dim small">该连接的标的为空：到「交易所连接」页，在连接卡片下方「标的」里添加</span>
            )}
            {connSymbols.length > 0 && symbols.length === 0 && (
              <span className="dim small">还没选标的 —— 点上面的代码即可选中</span>
            )}
          </div>

          {futuresConnection && (
            <Notice tone="info">
              当前连接是<b>合约模式</b>：策略可以直接做空，无需任何开关，
              组合按保证金账户记账（权益 = 现金 + 未实现盈亏），总名义敞口仍受单标的/组合上限约束。
              本地撮合<b>不模拟维持保证金、逐仓强平</b>；真实合约下单未开放。
              回测里的负持仓就是空头，不是记账错误。
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
          {err && (
            <div className="bot-error">
              {err}
              <Button variant="ghost" onClick={() => void load()} disabled={loading}>
                重试
              </Button>
            </div>
          )}
        </div>
      </Panel>

      {result && (
        <Panel
          title={`回测结果 · ${result.strategyName}`}
          subtitle={`${result.symbols.join(" / ")} · ${result.interval} · 每标的 ${result.barCount} 根 · 合计 ${result.bars} 根 · ${result.tradingMode === "futures" ? "合约模式 · " : ""}耗时 ${(result.durationMs / 1000).toFixed(1)}s`}
        >
          {result.tradingMode === "futures" && (
            <Notice tone="info">
              本次为<b>合约模式</b>：负数量是空头，权益按保证金账户计算（现金 + 未实现盈亏）。
              本地撮合不模拟资金费、维持保证金与强平；结果只用于验证方向与仓位逻辑。
            </Notice>
          )}
          <Notice tone="success">
            行情来自 {result.connectionLabel ?? "真实数据源"}；成交按<b>决策的下一根 K 线开盘价</b>模拟，
            已计手续费与滑点 —— 策略看不到还没发生的那一段。
          </Notice>
          <div className="grid-4">
            <Stat label="期末权益" value={money(result.metrics.finalEquity, 2)} tone={result.metrics.totalReturn >= 0 ? "up" : "down"} spark={result.equityCurve.map((p) => p.equity)} />
            <Stat label="收益率" value={signedPct(result.metrics.totalReturn)} tone={result.metrics.totalReturn >= 0 ? "up" : "down"} />
            <Stat label="已实现盈亏" value={signed(result.metrics.realizedPnl)} tone={result.metrics.realizedPnl >= 0 ? "up" : "down"} />
            <Stat label="成交笔数" value={String(result.metrics.totalFills)} />
            <Stat label="最大回撤" value={pct(result.metrics.maxDrawdownPct)} tone={result.metrics.maxDrawdownPct > 0.1 ? "down" : undefined} />
            <Stat label="期末持仓" value={String(result.metrics.openPositions)} />
          </div>

          {chart ? (
            <div className="backtest-kline">
              <div className="backtest-kline-head">
                <div>
                  <h4>盘面与操作</h4>
                  <div className="dim small">
                    K 线来自本次回测实际使用的行情，不是另拉一份；▲ 买入 / ▼ 卖出，悬停看成交价、数量与原因
                  </div>
                </div>
                <div className="btn-row" style={{ margin: 0, alignItems: "center" }}>
                  {(result.kline?.length ?? 0) > 1 && (
                    <div style={{ width: 180 }}>
                      <Select
                        value={chart.symbol}
                        options={(result.kline ?? []).map((k) => ({ value: k.symbol, label: k.symbol }))}
                        onChange={setChartSymbol}
                      />
                    </div>
                  )}
                  <Button small variant={showTrades ? "primary" : "ghost"} onClick={() => setShowTrades((v) => !v)}>
                    {showTrades ? "隐藏成交标记" : "显示成交标记"}
                  </Button>
                </div>
              </div>
              <KlineChart
                bars={chart.bars}
                trades={showTrades ? chartTrades : []}
                ma={chartMa}
                symbolLabel={chart.symbol}
              />
              {chartTrades.length === 0 && (
                <div className="dim small">这段行情里该标的没有成交；盘面仍保留，方便看策略为什么没动手。</div>
              )}
            </div>
          ) : (
            <Notice tone="warn">这份结果没有附带 K 线数据，无法回放盘面；请用新版服务端重新回测。</Notice>
          )}

          {result.equityCurve.length > 1 && (
            <div style={{ marginTop: 12 }}>
              <EquityChart curve={result.equityCurve} initialCash={result.initialCash} />
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

          <details className="collapse" style={{ marginTop: 12 }}>
            <summary>成交流水明细（{result.trades.length} 笔）</summary>
            <div className="collapse-body">
              <TradesTable trades={result.trades} />
            </div>
          </details>

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
          {loading ? (
            <div className="loading-inline">正在读取连接、策略与标的…</div>
          ) : connections.length === 0 ? (
            <Empty>
              还没有可用的交易所连接。先到「交易所连接」页加一条连接并挑好标的，再回来回测。
            </Empty>
          ) : strategies.length === 0 ? (
            <Empty>还没有策略。先到「策略」页建一条量化策略，再回来回测。</Empty>
          ) : (
            <Empty>
              选好连接、策略与标的{connSymbols.length === 0 ? "（当前连接的标的为空，先去「交易所连接」添加）" : ""}后点「开始回测」。
              结果只在本页显示，不写机器人的任何统计 ——
              机器人只根据实时行情跑，这里专门回答「这套参数在那段历史里行不行」。
            </Empty>
          )}
        </Panel>
      )}
    </div>
  );
}

function Stat({ label, value, tone, spark }: { label: string; value: string; tone?: "up" | "down"; spark?: number[] }) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <span className={`stat-value mono ${tone ?? ""}`}>{value}</span>
      {spark && spark.length > 1 && (
        <span className="stat-spark">
          <Sparkline values={spark.slice(-60)} width={64} height={22} />
        </span>
      )}
    </div>
  );
}

function describeSource(s: StrategyProfile): string {
  if (s.decisionSource === "rules") {
    if (s.selfAllocating) return "量化交易 · 因子选资产";
    const engine =
      s.engine === "adaptive"
        ? "自适应趋势"
        : s.engine === "breakout"
          ? "唐奇安突破"
          : s.engine === "meanrev"
            ? "均值回归"
            : "双均线";
    return `量化交易 · ${engine}`;
  }
  if (s.decisionSource === "hybrid") return "混合决策（不支持回测）";
  return `${s.decisionSource === "chat" ? "对话模型" : "决策模型"}（不支持回测）`;
}
