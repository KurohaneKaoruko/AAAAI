/**
 * 模拟对照：同一份行情、同一套风控、同一笔初始资金，多个选手各自独立操盘，
 * 横向比"谁的决策更赚钱"。选手可以是：
 * - 配置好的机器人（它用什么策略/模型就用什么）
 * - 策略列表里的任何一条（比策略参数）
 * - 模型实例（比模型，沿用默认策略参数）
 * - 动量基线（不调模型的参照系）
 *
 * 参赛者清单来自服务端（/api/bench/participants）：能勾哪些、为什么不能勾，
 * 以服务端为准 —— 前端自己猜会出现"勾了却跑不了"。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { AppStore } from "../state/useAppStore";
import type { ComparisonResult, Participant, RunnerResult } from "../types";
import { Button, Empty, Notice, NumberField, Panel } from "../components/ui";
import { Badge } from "../components/ui";
import { money, pct, signed, time } from "../lib/format";

const PALETTE = ["#4f8ef7", "#2fbf82", "#e3a53c", "#c699f0", "#f0554b", "#57b6c9", "#a06ef7", "#94a3b8"];

const TYPE_LABEL: Record<Participant["type"], string> = {
  baseline: "基线",
  bot: "机器人",
  strategy: "策略",
  model: "模型",
};

const SOURCE_LABEL: Record<string, string> = {
  rules: "量化交易",
  chat: "对话模型",
  systemone: "决策模型",
  hybrid: "混合决策",
};

const MAX_RUNNERS = 6;

export function ComparePage({ store, onNavigate }: { store: AppStore; onNavigate?: (target: "llm" | "pool") => void }) {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<ComparisonResult | null>(store.state?.comparison ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bars, setBars] = useState(store.state?.config?.market?.barCount ?? 200);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void api
      .participants()
      .then((d) => {
        setParticipants(d.participants);
        // 默认勾上：基线 + 所有可参赛者（上限内），减少一次"为什么没选上"的心智负担
        const runnable = d.participants.filter((p) => !p.unavailable && p.type !== "baseline").map((p) => p.key);
        const withBaseline = d.participants.some((p) => p.type === "baseline" && !p.unavailable) ? ["baseline"] : [];
        setPicked(new Set([...withBaseline, ...runnable].slice(0, MAX_RUNNERS)));
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  /** 对照标的以服务端解析的 runTarget 为准（它按连接过滤过） */
  const runTarget = store.state?.runTarget;
  const symbols = runTarget?.symbols ?? [];
  const targetError = runTarget?.error ?? null;

  const decisionInterval = Math.max(1, store.state?.config?.llm?.decisionInterval ?? 10);
  const modelRunners = participants.filter(
    (p) => picked.has(p.key) && !p.unavailable && p.decisionSource !== "rules",
  ).length;
  const estimatedCalls = Math.floor(bars / decisionInterval) * modelRunners;

  const blocked = useMemo(() => {
    if (!loaded) return "正在读取参赛者…";
    if (targetError) return targetError;
    if (participants.length === 0) return "还没有可参赛的东西：添加机器人、策略或模型都能参赛";
    if (picked.size === 0) return "还没有勾选参赛者";
    return null;
  }, [loaded, targetError, participants.length, picked.size]);

  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        if (next.size >= MAX_RUNNERS) {
          store.toast("error", `一次最多 ${MAX_RUNNERS} 个参赛者（并行跑，时间线性变长）`);
          return prev;
        }
        next.add(key);
      }
      return next;
    });

  const run = useCallback(async () => {
    if (blocked) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.runComparison({ keys: [...picked], bars });
      setResult(r.result);
      const top = r.result.results.find((x) => x.id === r.result.winners[0]);
      store.toast("success", `对照完成：${top?.label ?? "无"} 领先（${pct(top?.totalReturn ?? 0)}）`);
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      store.toast("error", msg);
    } finally {
      setBusy(false);
    }
  }, [blocked, picked, bars, store]);

  const ranked = useMemo(
    () => (result ? [...result.results].filter((r) => r.ok).sort((a, b) => b.totalReturn - a.totalReturn) : []),
    [result],
  );

  const groups: { type: Participant["type"]; title: string; hint: string }[] = [
    { type: "bot", title: "机器人", hint: "直接拿配置好的机器人上场：它引用哪条策略、哪些模型，就按那套跑" },
    { type: "strategy", title: "量化策略与决策策略", hint: "策略列表里的每一条都能单独上场 —— 比的就是这些参数" },
    { type: "model", title: "模型实例", hint: "沿用默认策略的参数，只换「谁来做决策」" },
    { type: "baseline", title: "参照系", hint: "同样的参数但不调模型 —— 有了它才知道模型是不是真比规则强" },
  ];

  return (
    <div className="page page-compare">
      <Panel
        title="模拟对照"
        subtitle="同一份行情、同一套风控、同一笔初始资金 —— 机器人、量化策略、模型同场竞技，比「谁更会赚钱」"
        actions={
          <Button variant="primary" onClick={() => void run()} busy={busy} disabled={blocked !== null}>
            {busy ? "对照中…" : result ? "重新对照" : "开始对照"}
          </Button>
        }
      >
        {/* 一句话说清"点了会发生什么"，以及为什么现在点不了 */}
        <div className={`compare-status ${blocked ? "compare-blocked" : "compare-ready"}`}>
          {blocked ? (
            <>
              <span className="compare-status-lead">还不能开始：</span>
              {blocked}
              {targetError && targetError.includes("候选池") && onNavigate && (
                <Button small onClick={() => onNavigate("pool")}>
                  去候选池 →
                </Button>
              )}
            </>
          ) : (
            <>
              <span className="compare-status-lead">可以开始：</span>
              {picked.size} 个参赛者 · {symbols.length} 个标的（{runTarget?.connectionLabel}） · {bars} 根 K 线
              {modelRunners > 0 && (
                <>
                  {" "}
                  · 预计 <b className="mono">≈{estimatedCalls}</b> 次模型调用（每 {decisionInterval} 根问一次）
                </>
              )}
            </>
          )}
        </div>

        <div className="grid-2">
          <NumberField
            label="K 线数量"
            hint="各选手看到的行情完全相同；越多越慢、模型调用越多"
            value={bars}
            min={30}
            max={1000}
            step={20}
            onChange={setBars}
          />
          <div className="field">
            <span className="field-label">对照标的（来自候选池，服务端按连接解析）</span>
            <div className="chip-row" style={{ marginTop: 6 }}>
              {symbols.length > 0 ? (
                symbols.map((s) => (
                  <span className="chip chip-sm mono" key={s}>
                    {s}
                  </span>
                ))
              ) : (
                <span className="dim small">（无）</span>
              )}
            </div>
          </div>
        </div>

        {participants.length === 0 && loaded ? (
          <div className="explain-box" style={{ marginTop: 12 }}>
            <strong>三步就能跑起来</strong>
            <p>
              ① 在 <b>交易机器人</b> 建一个机器人，或者到 <b>策略</b> 页加一条策略；
              ② 有模型的话到 <b>模型管理</b> 添加实例并填 Key；
              ③ 回到本页勾选参赛者，点「开始对照」。
            </p>
            <div className="btn-row">
              {onNavigate && (
                <Button small onClick={() => onNavigate("pool")}>
                  去候选池选标的 →
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="participant-groups">
            {groups.map(({ type, title, hint }) => {
              const items = participants.filter((p) => p.type === type);
              if (items.length === 0) return null;
              return (
                <div className="participant-group" key={type}>
                  <div className="participant-group-head">
                    <span className="strong">{title}</span>
                    <span className="dim small">{hint}</span>
                  </div>
                  <div className="participant-grid">
                    {items.map((p) => {
                      const off = Boolean(p.unavailable);
                      const on = picked.has(p.key);
                      return (
                        <button
                          key={p.key}
                          type="button"
                          className={`participant-card ${on ? "participant-on" : ""} ${off ? "participant-off" : ""}`}
                          onClick={() => !off && toggle(p.key)}
                          disabled={off}
                          title={off ? p.unavailable : undefined}
                        >
                          <div className="participant-line">
                            <Badge tone={p.type === "baseline" ? "neutral" : p.type === "bot" ? "accent" : p.type === "model" ? "warn" : undefined}>
                              {TYPE_LABEL[p.type]}
                            </Badge>
                            <span className="strong">{p.name}</span>
                            {on && <span className="participant-check">✓ 已选</span>}
                          </div>
                          <div className="dim small">{p.detail}</div>
                          <div className="participant-meta small">
                            <span className="chip chip-sm">{SOURCE_LABEL[p.decisionSource] ?? p.decisionSource}</span>
                            <span className="chip chip-sm mono">
                              {p.params.fastWindow}/{p.params.slowWindow}
                            </span>
                            <span className="chip chip-sm">仓位≤{Math.round(p.params.maxTargetWeight * 100)}%</span>
                            {p.models.map((m) => (
                              <span className="chip chip-sm" key={m}>
                                {m}
                              </span>
                            ))}
                          </div>
                          {off && <div className="participant-reason small">{p.unavailable}</div>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {error && <Notice tone="error">{error}</Notice>}
        <Notice tone="info">
          对照只在模拟盘中进行，绝不会发出真实订单。所有选手共用同一份行情与初始资金；
          每位选手只跑自己那一类决策来源，因此是单变量比较。机器人参赛时用它引用的策略与模型，
          但资金按对照实验统一设定（不用机器人自己的资金配置）。
        </Notice>
      </Panel>

      {result && (
        <>
          <Panel
            title="战绩排行"
            subtitle={`${result.bars} 根 K 线 · ${result.symbols.join(" / ")} · 耗时 ${(result.durationMs / 1000).toFixed(1)}s · ${time(result.finishedAt)}`}
          >
            <div className="hint-line">
              看「总收益」排名；<b>最大回撤</b>越小越稳；<b>胜率</b>是盈利交易占比；
              <b>盈亏比</b>是平均盈利 / 平均亏损（∞ 表示没有亏损交易）。收益高但回撤也大的选手，实际不一定更好用。
              每位选手下方列出了它实际生效的策略参数 —— 用它核对"跑的确实是我选的那条"。
            </div>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>选手</th>
                    <th>来源</th>
                    <th>决策</th>
                    <th>实际参数</th>
                    <th className="num">总收益</th>
                    <th className="num">权益</th>
                    <th className="num">最大回撤</th>
                    <th className="num">胜率</th>
                    <th className="num">盈亏比</th>
                    <th className="num">成交</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((r, i) => (
                    <tr key={r.id} className={i === 0 ? "row-winner" : ""}>
                      <td className="mono">{i === 0 ? "🏆" : i + 1}</td>
                      <td className="strong">
                        <span className="runner-dot" style={{ background: PALETTE[i % PALETTE.length] }} />
                        {r.label}
                        {r.model && <span className="dim small"> · {r.model}</span>}
                      </td>
                      <td>
                        <Badge tone={r.origin?.type === "bot" ? "accent" : r.origin?.type === "model" ? "warn" : "neutral"}>
                          {TYPE_LABEL[r.origin?.type ?? "strategy"]}
                        </Badge>
                      </td>
                      <td className="small">{SOURCE_LABEL[r.decisionSource] ?? r.decisionSource}</td>
                      <td className="small mono dim">
                        {r.params.fastWindow}/{r.params.slowWindow} · ≤{Math.round(Number(r.params.maxTargetWeight) * 100)}%
                      </td>
                      <td className={`mono num ${r.totalReturn >= 0 ? "up" : "down"}`}>{pct(r.totalReturn)}</td>
                      <td className="num mono">{money(r.finalEquity)}</td>
                      <td className="num mono dim">{pct(r.maxDrawdownPct)}</td>
                      <td className="num mono">{r.winRate > 0 ? pct(r.winRate, 0) : "—"}</td>
                      <td className="num mono">{Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "∞"}</td>
                      <td className="num mono">{r.fillCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="权益曲线对比" subtitle="同一坐标系，越靠上越好">
            <CompareChart results={ranked} initialCash={result.initialCash} />
          </Panel>

          <Panel title="各选手持仓">
            <div className="grid-2">
              {ranked.map((r, i) => (
                <RunnerPositions key={r.id} result={r} color={PALETTE[i % PALETTE.length]} />
              ))}
            </div>
          </Panel>
        </>
      )}

      {!result && loaded && participants.length > 0 && !blocked && (
        <Panel title="结果">
          <Empty>勾选参赛者后点右上角「开始对照」，结果会出现在这里 —— 排名、权益曲线、各选手持仓。</Empty>
        </Panel>
      )}
    </div>
  );
}

function CompareChart({ results, initialCash }: { results: RunnerResult[]; initialCash: number }) {
  const W = 900;
  const H = 300;
  const pad = { top: 18, right: 20, bottom: 26, left: 64 };

  const series = results.filter((r) => r.equityCurve.length > 1);
  if (series.length === 0) return <Empty>暂无权益数据</Empty>;

  const all = series.flatMap((r) => r.equityCurve.map((p) => p.equity));
  const min = Math.min(...all, initialCash);
  const max = Math.max(...all, initialCash);
  const span = max - min || Math.max(max * 0.01, 1);
  const maxLen = Math.max(...series.map((r) => r.equityCurve.length));

  const x = (i: number, len: number) => pad.left + (len <= 1 ? 0 : (i / (len - 1)) * (W - pad.left - pad.right));
  const y = (v: number) => pad.top + (1 - (v - min) / span) * (H - pad.top - pad.bottom);

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="权益曲线对比">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const v = min + span * t;
          return (
            <g key={t}>
              <line x1={pad.left} x2={W - pad.right} y1={y(v)} y2={y(v)} className="grid-line" />
              <text x={pad.left - 10} y={y(v) + 4} className="axis-text" textAnchor="end">
                {v.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}
              </text>
            </g>
          );
        })}
        <line x1={pad.left} x2={W - pad.right} y1={y(initialCash)} y2={y(initialCash)} className="baseline-line" />
        {series.map((r, idx) => {
          const color = PALETTE[idx % PALETTE.length];
          const d = r.equityCurve
            .map((p, i) => `${i === 0 ? "M" : "L"}${x(i, r.equityCurve.length).toFixed(1)},${y(p.equity).toFixed(1)}`)
            .join(" ");
          return <path key={r.id} d={d} fill="none" stroke={color} strokeWidth={2} />;
        })}
      </svg>
      <div className="chart-legend">
        {series.map((r, idx) => (
          <span className="legend-item" key={r.id}>
            <span className="runner-dot" style={{ background: PALETTE[idx % PALETTE.length] }} />
            {r.label}
            <b className={r.totalReturn >= 0 ? "up" : "down"}>{pct(r.totalReturn)}</b>
          </span>
        ))}
        <span className="legend-item dim">共 {maxLen} 个数据点</span>
      </div>
    </div>
  );
}

function RunnerPositions({ result, color }: { result: RunnerResult; color: string }) {
  return (
    <div className="runner-positions">
      <div className="runner-positions-head">
        <span className="runner-dot" style={{ background: color }} />
        <span className="strong">{result.label}</span>
        <span className={`mono ${result.totalReturn >= 0 ? "up" : "down"}`}>{pct(result.totalReturn)}</span>
      </div>
      {result.positions.length === 0 ? (
        <div className="dim small">空仓</div>
      ) : (
        <table className="table">
          <tbody>
            {result.positions.map((p) => (
              <tr key={p.symbol}>
                <td className="mono">{p.symbol}</td>
                <td className="num mono">{p.quantity.toFixed(4)}</td>
                <td className="num mono dim">成本 {p.avgCost.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
