/** 交易机器人：多个自动化交易并行运行，每个独立配置模型、策略与标的。 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AppStore } from "../state/useAppStore";
import type { Bot, BotAllocation, BotInput, DecisionSource, LlmProfile, PopularSymbol, StrategyProfile } from "../types";
import { Button, Empty, Notice, NumberField, Panel, SelectField, TextField, Toggle } from "../components/ui";
import { SOURCE_ZH } from "../components/DecisionSourceSwitch";
import { StrategyPicker, describe } from "../components/StrategyProfiles";
import { money, pct, time } from "../lib/format";

const STATUS: Record<string, { text: string; cls: string }> = {
  idle: { text: "待机", cls: "badge-idle" },
  running: { text: "运行中", cls: "badge-running" },
  stopped: { text: "已停止", cls: "badge-stopped" },
  error: { text: "异常", cls: "badge-error" },
};

export function BotsPage({ store }: { store: AppStore }) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  const [strategies, setStrategies] = useState<StrategyProfile[]>([]);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Bot | null>(null);

  const reload = useCallback(async () => {
    try {
      const [b, p, st] = await Promise.all([api.bots(), api.llmProfiles(), api.strategies()]);
      setBots(b.bots);
      setProfiles(p.profiles);
      setStrategies(st.strategies);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [reload]);

  const start = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const r = await api.startBot(id);
      const s = r.state as { status: string; error?: string | null };
      if (s.status === "error") setError(s.error ?? "启动失败");
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const stop = async (id: string) => {
    await api.stopBot(id).catch(() => undefined);
    await reload();
  };

  const startAll = async () => {
    setBusyId("all");
    try {
      await api.startAllBots();
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const stopAll = async () => {
    await api.stopAllBots();
    await reload();
  };

  const runningCount = bots.filter((b) => b.state.status === "running").length;

  return (
    <div className="page page-bots">
      <Panel
        title="交易机器人"
        subtitle={`${bots.length} 个机器人 · ${runningCount} 个运行中 · 每个独立配置模型与策略`}
        actions={
          <div className="btn-row" style={{ margin: 0 }}>
            <Button small onClick={startAll} busy={busyId === "all"} disabled={bots.length === 0}>
              全部启动
            </Button>
            <Button small variant="danger" onClick={stopAll} disabled={runningCount === 0}>
              全部停止
            </Button>
            <Button variant="primary" small onClick={() => { setCreating((v) => !v); setEditing(null); }}>
              {creating ? "取消" : "+ 新建机器人"}
            </Button>
          </div>
        }
      >
        {creating && <BotForm store={store} profiles={profiles} strategies={strategies} onDone={() => { setCreating(false); void reload(); }} />}
        {editing && (
          <BotForm
            store={store}
            profiles={profiles}
            strategies={strategies}
            editing={editing}
            onDone={() => { setEditing(null); void reload(); }}
          />
        )}
        {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}

        {bots.some((b) => b.state.allocation) && <AllocationOverview bots={bots} />}

        {bots.length === 0 && !creating ? (
          <Empty>
            还没有机器人。点「新建机器人」配置一个：它有自己的标的、模型、策略和资金，互不干扰，可并行运行。
          </Empty>
        ) : (
          <div className="bot-list">
            {bots.map((b) => (
              <BotCard
                key={b.id}
                bot={b}
                strategies={strategies}
                busy={busyId === b.id}
                onStart={() => void start(b.id)}
                onStop={() => void stop(b.id)}
                onEdit={() => { setEditing(b); setCreating(false); }}
                onDelete={async () => {
                  if (confirm(`删除机器人「${b.name}」？`)) {
                    await api.deleteBot(b.id).catch(() => undefined);
                    void reload();
                  }
                }}
                onToggle={async (v) => {
                  await api.updateBot(b.id, { enabled: v });
                  void reload();
                }}
              />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function BotCard({
  bot,
  strategies,
  busy,
  onStart,
  onStop,
  onEdit,
  onDelete,
  onToggle,
}: {
  bot: Bot;
  strategies: StrategyProfile[];
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (v: boolean) => void;
}) {
  const st = STATUS[bot.state.status] ?? STATUS.idle!;
  const m = bot.state.metrics;
  const a = bot.state.allocation;
  const running = bot.state.status === "running";

  return (
    <div className="bot-card">
      <div className="bot-card-head">
        <span className="bot-name">{bot.name}</span>
        <span className={`badge ${st.cls}`}>{st.text}</span>
        <span className="chip chip-sm">{bot.mode === "live" ? "持续运行" : "回测"}</span>
        {/* "实盘下单中" 只在真的在跑的时候出现：停了还挂着这四个字会让人以为订单还在发 */}
        {bot.state.liveTrading && bot.state.status === "running" && (
          <span className="chip chip-sm chip-live">实盘下单中</span>
        )}
        {bot.state.liveTrading && bot.state.status !== "running" && (
          <span className="chip chip-sm chip-off">上次运行为实盘</span>
        )}
        {bot.mode === "live" && !bot.state.liveTrading && bot.state.status !== "running" && (
          <span className="chip chip-sm chip-off">实时模式 · 未实盘</span>
        )}
        <span className="chip chip-sm">{bot.interval}</span>
        <div className="bot-actions">
          <Button small variant="primary" onClick={onStart} disabled={running} busy={busy}>
            {running ? "运行中" : "启动"}
          </Button>
          <Button small variant="danger" onClick={onStop} disabled={!running}>
            停止
          </Button>
          <Button small onClick={onEdit}>编辑</Button>
          <Button small variant="ghost" onClick={onDelete}>删除</Button>
        </div>
      </div>

      <div className="bot-meta">
        <span><em>标的</em> <b className="mono">{bot.symbols.join(" / ")}</b></span>
        <span>
          <em>模型</em>{" "}
          <b>{bot.modelLabels.length > 0 ? bot.modelLabels.join(bot.decisionSource === "hybrid" ? " → " : " / ") : "未选择"}</b>
        </span>
        <span>
          <em>策略</em>{" "}
          <b className="mono">
            {(() => {
              const s = strategies.find((x) => x.id === bot.strategyId);
              if (s) return describe(s);
              // 老机器人还没有 strategyId：退回读它自己的参数
              return bot.decisionSource === "hybrid"
                ? `大模型分析→决策模型定仓位·影响力 ${pct(bot.strategy.hybridInfluence, 0)}`
                : bot.strategy.selfAllocating
                  ? `AI 选资产·最多 ${bot.strategy.maxPositions} 个`
                  : `双均线 ${bot.strategy.fastWindow}/${bot.strategy.slowWindow}`;
            })()}
          </b>
        </span>
        <span><em>资金</em> <b className="mono">{money(bot.risk.initialCash, 0)}</b></span>
      </div>

      {m ? (
        <div className="bot-stats">
          <span>权益 <b className="mono">{money(m.finalEquity)}</b></span>
          <span className={m.totalReturn >= 0 ? "up" : "down"}>
            收益 <b className="mono">{(m.totalReturn * 100).toFixed(2)}%</b>
          </span>
          <span>成交 <b className="mono">{m.totalFills}</b></span>
          <span>回撤 <b className="mono">{pct(m.maxDrawdownPct)}</b></span>
          <span>持仓 <b className="mono">{m.openPositions}</b></span>
          <span className="dim">
            {bot.state.bars} 根 · {(bot.state.durationMs / 1000).toFixed(1)}s
          </span>
        </div>
      ) : (
        <div className="bot-stats dim small">尚未产生数据 —— 点「启动」开始</div>
      )}

      {a && <AllocationBars alloc={a} />}

      {bot.state.error && <div className="bot-error">{bot.state.error}</div>}

      {bot.state.events.length > 0 && (
        <details className="bot-events">
          <summary>最近事件（{bot.state.events.length}）</summary>
          <div className="event-log" style={{ maxHeight: 160 }}>
            {[...bot.state.events].reverse().slice(0, 50).map((e, i) => (
              <div className="event-row" key={`${e.timestamp}-${i}`}>
                <span className="event-time mono">{time(e.timestamp)}</span>
                <span className="event-topic">{e.topic.split(".").pop()}</span>
                <span className="event-summary mono">{e.summary}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      <Toggle label="参与「全部启动」" checked={bot.enabled} onChange={onToggle} />
    </div>
  );
}

/** 小权重也要看得清：0.2% 不能显示成 0%。 */
function wPct(w: number): string {
  const digits = w > 0 && w < 0.01 ? 2 : w > 0 && w < 0.1 ? 1 : 0;
  return `${(w * 100).toFixed(digits)}%`;
}

/** 各账号资产配置一览：横向对比谁把钱放在哪。 */
function AllocationOverview({ bots }: { bots: Bot[] }) {
  const rows = bots.filter((b) => b.state.allocation);
  const symbols = [...new Set(rows.flatMap((b) => b.state.allocation!.holdings.map((h) => h.symbol)))];
  if (rows.length === 0 || symbols.length === 0) return null;
  return (
    <div className="alloc-overview">
      <div className="alloc-overview-head">
        <span>各账号资产配置</span>
        <span className="dim small">按权重对比，空白表示该账号没持有</span>
      </div>
      <div className="table-scroll">
        <table className="table alloc-table">
          <thead>
            <tr>
              <th>账号</th>
              <th className="num">权益</th>
              {symbols.map((sym) => (
                <th key={sym} className="num">{sym}</th>
              ))}
              <th className="num">现金</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const a = b.state.allocation!;
              const held = new Map(a.holdings.map((h) => [h.symbol, h]));
              return (
                <tr key={b.id}>
                  <td>
                    <span className="mono strong">{b.name}</span>
                    <span className="dim small"> · {SOURCE_ZH[b.decisionSource]}</span>
                  </td>
                  <td className="mono num">{money(a.equity, 0)}</td>
                  {symbols.map((sym) => {
                    const h = held.get(sym);
                    return (
                      <td key={sym} className={`num mono ${h ? (h.unrealizedPnl >= 0 ? "up" : "down") : "dim"}`}>
                        {h ? wPct(h.weight) : "—"}
                      </td>
                    );
                  })}
                  <td className="num mono dim">{wPct(a.cashWeight)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 一个账号当前的资产配置：各标的权重条 + 现金。 */
function AllocationBars({ alloc }: { alloc: BotAllocation }) {
  const [hover, setHover] = useState<string | null>(null);
  if (alloc.holdings.length === 0) {
    return (
      <div className="alloc">
        <div className="alloc-head">
          <span>资产配置</span>
          <span className="dim mono">全部现金</span>
        </div>
        <div className="alloc-bar">
          <div className="alloc-seg alloc-cash" style={{ width: "100%" }} />
        </div>
      </div>
    );
  }
  return (
    <div className="alloc">
      <div className="alloc-head">
        <span>资产配置</span>
        <span className="dim mono">
          持仓 {alloc.heldCount} · 现金 {wPct(alloc.cashWeight)} · 权益 {money(alloc.equity, 0)}
        </span>
      </div>
      <div className="alloc-bar">
        {alloc.holdings.map((h) => (
          <div
            key={h.symbol}
            className={`alloc-seg alloc-seg-${(h.symbol.charCodeAt(0) % 5) + 1} ${hover === h.symbol ? "alloc-hover" : ""}`}
            style={{ width: `${Math.max(h.weight * 100, 0.5)}%` }}
            title={`${h.symbol} ${money(h.marketValue)} · 权重 ${pct(h.weight, 0)} · ${h.quantity} @ ${money(h.price, h.price > 100 ? 2 : 4)}`}
            onMouseEnter={() => setHover(h.symbol)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
        {alloc.cashWeight > 0.001 && (
          <div className="alloc-seg alloc-cash" style={{ width: `${alloc.cashWeight * 100}%` }} title={`现金 ${money(alloc.cash)}`} />
        )}
      </div>
      <div className="alloc-legend">
        {alloc.holdings.map((h) => (
          <span key={h.symbol} className={`alloc-item ${hover && hover !== h.symbol ? "alloc-dim" : ""}`}>
            <i className={`alloc-dot alloc-seg-${(h.symbol.charCodeAt(0) % 5) + 1}`} />
            <b className="mono">{h.symbol}</b>
            <span className="mono dim">{wPct(h.weight)}</span>
            <span className={`mono ${h.unrealizedPnl >= 0 ? "up" : "down"}`}>
              {h.unrealizedPnl >= 0 ? "+" : ""}
              {money(h.unrealizedPnl, 0)}
            </span>
          </span>
        ))}
        {alloc.cashWeight > 0.001 && (
          <span className="alloc-item">
            <i className="alloc-dot alloc-cash" />
            <b>现金</b>
            <span className="mono dim">{wPct(alloc.cashWeight)}</span>
            <span className="mono dim">{money(alloc.cash, 0)}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function BotForm({
  store,
  profiles,
  strategies,
  editing,
  onDone,
}: {
  store: AppStore;
  profiles: LlmProfile[];
  strategies: StrategyProfile[];
  editing?: Bot | null;
  onDone: () => void;
}) {
  const { connections, watchlist } = store;
  const [name, setName] = useState(editing?.name ?? "");
  // 机器人只存策略 id：参数以策略列表为准，避免两处配置对不上
  const [strategyId, setStrategyId] = useState(editing?.strategyId ?? strategies[0]?.id ?? "");
  const [connectionId, setConnectionId] = useState(editing?.connectionId ?? connections[0]?.id ?? "");
  const [symbols, setSymbols] = useState<string[]>(editing?.symbols ?? []);
  const [mode, setMode] = useState<"live" | "backtest">(editing?.mode ?? "live");
  const [decisionSource, setDecisionSource] = useState<DecisionSource>(editing?.decisionSource ?? "rules");
  const [modelIds, setModelIds] = useState<string[]>(editing?.modelProfileIds ?? []);
  const [interval, setInterval] = useState(editing?.interval ?? "1m");
  const [barCount, setBarCount] = useState(editing?.barCount ?? 200);
  const [decisionInterval, setDecisionInterval] = useState(editing?.decisionInterval ?? 10);
  const [cash, setCash] = useState(editing?.risk.initialCash ?? 100000);
  const [minTrade, setMinTrade] = useState(editing?.risk.minTradeValue ?? 0);
  const [maxDD, setMaxDD] = useState(editing?.risk.maxDrawdownPct ?? 0.15);
  const [popular, setPopular] = useState<PopularSymbol[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!connectionId) return;
    void api.popular(connectionId, 24).then((d) => setPopular(d.symbols)).catch(() => setPopular([]));
  }, [connectionId]);

  const connSymbols = watchlist.filter((w) => w.connectionId === connectionId).map((w) => w.symbol);
  // 实时 ≠ 实盘：是否真下单取决于「风控」页的执行方式
  const executionMode = store.state?.config?.execution?.mode ?? "paper";
  // 混合决策需要同时用对话模型（分析端）与决策模型（决策端），其余各用自己的那一类
  const chosen = strategies.find((s) => s.id === strategyId);
  const source: DecisionSource = chosen?.decisionSource ?? decisionSource;
  const modelKinds: ("chat" | "systemone")[] =
    source === "hybrid" ? ["chat", "systemone"] : source === "rules" ? [] : [source];
  const intervals =
    connections.find((c) => c.id === connectionId)?.adapter?.klineIntervals ??
    ["1m", "5m", "15m", "1h", "4h", "1d"];

  const submit = async () => {
    setBusy(true);
    setErr(null);
    const body: BotInput = {
      name,
      connectionId,
      symbols,
      mode,
      interval,
      barCount,
      ...(strategyId ? { strategyId } : {}),
      modelProfileIds: source === "rules" ? [] : modelIds,
      decisionInterval,
      risk: { initialCash: cash, minTradeValue: minTrade, maxDrawdownPct: maxDD },
    };
    try {
      if (editing) {
        await api.updateBot(editing.id, body);
      } else {
        await api.createBot(body);
      }
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connection-form">
      <div className="grid-2">
        <TextField label="名称" value={name} onChange={setName} placeholder="如：BTC 趋势跟踪" />
        {strategies.length > 0 ? (
          <StrategyPicker items={strategies} value={strategyId} onChange={setStrategyId} />
        ) : (
          <div className="field">
            <span className="field-label">策略</span>
            <div className="dim small">
              还没有策略。请到「策略」页新建一条，机器人会引用它（窗口、是否 AI 选资产、混合影响力都在那里配）。
            </div>
          </div>
        )}
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
          label="运行模式"
          value={mode}
          options={[
            { value: "live", label: "实时（持续轮询行情）" },
            { value: "backtest", label: "回测（跑一次历史）" },
          ]}
          onChange={(v) => setMode(v as "live" | "backtest")}
        />
        {mode === "live" && (
          <Notice tone={executionMode === "live" ? "warn" : "error"}>
            {executionMode === "live"
              ? "「风控」页的执行方式是真实下单：这个机器人启动后会真的向交易所发订单。且同一连接同时只允许一个实盘机器人。"
              : "「风控」页的执行方式目前是模拟成交：这个机器人可以实时跑，但成交只发生在本地，不会下真实订单（启动时会被拒绝，需先把执行方式改成真实下单）。"}
          </Notice>
        )}
        <div className="grid-2">
          <div className="field">
            <span className="field-label">决策来源</span>
            <div className="dim small">
              {chosen ? describe(chosen) : "选择一条策略"}
              {chosen && !chosen.selfAllocating && chosen.decisionSource !== "rules" ? " · 模型只定仓位" : ""}
            </div>
          </div>
        </div>
      </div>

      <div className="symbol-picker">
        <div className="symbol-picker-head">运行标的（可多选）</div>
        <div className="chip-row">
          {[...new Set([...connSymbols, ...popular.map((p) => p.symbol)])].map((s) => (
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
          {connSymbols.length === 0 && popular.length === 0 && (
            <span className="dim small">该连接的候选池为空，请先到「策略 → 候选池」添加</span>
          )}
        </div>
      </div>

      {modelKinds.length > 0 && (
        <div className="symbol-picker">
          <div className="symbol-picker-head">
            本机器人使用的模型（留空 = 该类型全部实例）
          </div>
          <div className="chip-row">
            {modelKinds.flatMap((kind) => profiles.filter((p) => p.kind === kind && p.enabled && p.hasKey)).map((p) => (
              <button
                key={p.id}
                type="button"
                className={`symbol-chip ${modelIds.includes(p.id) ? "symbol-on" : ""}`}
                onClick={() =>
                  setModelIds((prev) =>
                    prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id],
                  )
                }
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {chosen ? (
        <div className="explain-box">
          <strong>本机器人将使用策略「{chosen.name}」</strong>
          <p>
            {chosen.decisionSource === "rules"
              ? `量化交易：双均线 ${chosen.fastWindow}/${chosen.slowWindow}，目标仓位最高 ${pct(chosen.maxTargetWeight, 0)}，不调用任何模型。`
              : `${chosen.decisionSource === "hybrid" ? "混合决策" : chosen.decisionSource === "chat" ? "对话模型" : "决策模型"}；` +
                (chosen.selfAllocating
                  ? `由 AI 在候选池里自选资产（最多 ${chosen.maxPositions} 个、总仓位 ${pct(chosen.maxGrossExposure, 0)}，每 ${chosen.allocationInterval} 轮配置一次）。`
                  : `按上面的标的逐个定仓位，目标仓位最高 ${pct(chosen.maxTargetWeight, 0)}。`)}
            {chosen.decisionSource === "hybrid" && `分析影响力 ${pct(chosen.hybridInfluence, 0)}。`}
          </p>
          <p className="dim">
            想改这些参数，去「策略」页编辑「{chosen.name}」—— 改一处，所有引用它的机器人同时生效。
          </p>
        </div>
      ) : null}

      <div className="grid-3">
        <SelectField
          label="K 线周期"
          value={interval}
          options={intervals.map((i) => ({ value: i, label: i }))}
          onChange={setInterval}
        />
        <NumberField label={mode === "live" ? "预热 K 线" : "回测 K 线"} value={barCount} step={20} min={20} max={1000} onChange={setBarCount} />
        {modelKinds.length > 0 && (
          <NumberField label="决策间隔" hint="每 N 根问一次" value={decisionInterval} min={1} max={100} onChange={setDecisionInterval} />
        )}
        <NumberField label="初始资金" value={cash} step={1000} min={100} onChange={setCash} />
        <NumberField label="最小调仓额" hint="低于不下单" value={minTrade} step={500} min={0} onChange={setMinTrade} />
        <NumberField label="回撤熔断" hint={pct(maxDD, 0)} value={maxDD} step={0.01} min={0.01} max={1} onChange={setMaxDD} />
      </div>

      {symbols.length === 0 && <Notice tone="warn">请至少选择一个标的</Notice>}
      {err && <Notice tone="error">{err}</Notice>}

      <div className="btn-row">
        <Button variant="primary" onClick={submit} busy={busy} disabled={!name.trim() || symbols.length === 0}>
          {editing ? "保存" : "创建机器人"}
        </Button>
        <Button onClick={onDone}>取消</Button>
      </div>
    </div>
  );
}