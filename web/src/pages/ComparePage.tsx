/** 多模型对照页：同一份行情，各模型独立操盘，横向比战绩。 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { AppStore } from "../state/useAppStore";
import type { ComparisonResult, LlmProfile, RunnerResult } from "../types";
import { Button, Empty, Notice, NumberField, Panel, SelectField } from "../components/ui";
import { Select } from "../components/Select";
import { Badge } from "../components/ui";
import { money, pct, signed, time } from "../lib/format";

const PALETTE = ["#4f8ef7", "#2fbf82", "#e3a53c", "#c699f0", "#f0554b", "#57b6c9", "#a06ef7", "#94a3b8"];

const KIND_LABEL: Record<string, string> = {
  baseline: "基线",
  chat: "对话模型",
  systemone: "决策模型",
};

export function ComparePage({ store }: { store: AppStore }) {
  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<ComparisonResult | null>(store.state?.comparison ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeBaseline, setIncludeBaseline] = useState(true);
  const [bars, setBars] = useState(store.state?.config?.market?.barCount ?? 200);

  useEffect(() => {
    void api.llmProfiles().then((d) => {
      setProfiles(d.profiles);
      // 默认全选可用的
      setPicked(new Set(d.profiles.filter((p) => p.enabled && p.hasKey).map((p) => p.id)));
    });
  }, []);

  const usable = useMemo(() => profiles.filter((p) => p.enabled && p.hasKey), [profiles]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.runComparison({
        runnerIds: [...picked],
        bars,
        includeBaseline,
      });
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
  };

  const ranked = useMemo(
    () => (result ? [...result.results].sort((a, b) => b.totalReturn - a.totalReturn) : []),
    [result],
  );

  return (
    <div className="page page-compare">
      <Panel
        title="对照实验设置"
        subtitle="同一份行情 · 同一套风控 · 各自独立资金账户"
        actions={
          <Button variant="primary" onClick={run} busy={busy} disabled={picked.size === 0}>
            开始对照
          </Button>
        }
      >
        <div className="grid-2">
          <NumberField
            label="K 线数量"
            hint="各选手看到的行情完全相同"
            value={bars}
            min={30}
            max={1000}
            step={20}
            onChange={setBars}
          />
          <SelectField
            label="基线对照"
            value={includeBaseline ? "on" : "off"}
            options={[
              { value: "on", label: "包含动量基线（不调模型）" },
              { value: "off", label: "只跑模型" },
            ]}
            onChange={(v) => setIncludeBaseline(v === "on")}
          />
        </div>

        {usable.length === 0 ? (
          <Empty>
            还没有可用模型。请先到「LLM 大模型」页添加实例并填写密钥。
          </Empty>
        ) : (
          <>
            <div className="symbol-picker-head" style={{ marginTop: 6 }}>参赛模型（可多选）</div>
            <div className="runner-picker">
              {usable.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`runner-chip ${picked.has(p.id) ? "runner-on" : ""}`}
                  onClick={() => toggle(p.id)}
                >
                  <span className="runner-kind">{KIND_LABEL[p.kind] ?? p.kind}</span>
                  <span className="runner-name">{p.label}</span>
                  <span className="runner-model mono">{p.model}</span>
                </button>
              ))}
            </div>
            <div className="btn-row" style={{ marginTop: 10 }}>
              <Button small onClick={() => setPicked(new Set(usable.map((p) => p.id)))}>全选</Button>
              <Button small onClick={() => setPicked(new Set())}>清空</Button>
            </div>
          </>
        )}

        {error && <Notice tone="error">{error}</Notice>}
        <Notice tone="info">
          对照实验只在模拟盘中进行，绝不会发出真实订单。同一根 K 线按时间顺序依次进入各模型，
          因此结果可直接横向比较。
        </Notice>
      </Panel>

      {result && (
        <>
          <Panel
            title="战绩排行"
            subtitle={`${result.bars} 根 K 线 · ${result.symbols.join(" / ")} · 耗时 ${(result.durationMs / 1000).toFixed(1)}s · ${time(result.finishedAt)}`}
          >
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>选手</th>
                    <th>类型</th>
                    <th className="num">总收益</th>
                    <th className="num">权益</th>
                    <th className="num">最大回撤</th>
                    <th className="num">胜率</th>
                    <th className="num">盈亏比</th>
                    <th className="num">成交</th>
                    <th className="num">已实现</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((r, i) => (
                    <tr key={r.id} className={i === 0 ? "row-winner" : ""}>
                      <td className="mono">{i === 0 ? "🏆" : i + 1}</td>
                      <td className="strong">
                        <span
                          className="runner-dot"
                          style={{ background: PALETTE[i % PALETTE.length] }}
                        />
                        {r.label}
                        {r.model && <span className="dim small"> · {r.model}</span>}
                      </td>
                      <td>
                        <Badge tone={r.kind === "systemone" ? "accent" : r.kind === "baseline" ? "neutral" : "warn"}>
                          {KIND_LABEL[r.kind]}
                        </Badge>
                      </td>
                      <td className={`mono num ${r.totalReturn >= 0 ? "up" : "down"}`}>
                        {pct(r.totalReturn)}
                      </td>
                      <td className="mono num">{money(r.finalEquity)}</td>
                      <td className="mono num dim">{pct(r.maxDrawdownPct)}</td>
                      <td className="mono num">{r.winRate > 0 ? pct(r.winRate, 0) : "—"}</td>
                      <td className="mono num">
                        {Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "∞"}
                      </td>
                      <td className="mono num">{r.fillCount}</td>
                      <td className={`mono num ${r.realizedPnl >= 0 ? "up" : "down"}`}>
                        {r.realizedPnl === 0 ? "—" : signed(r.realizedPnl)}
                      </td>
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
                <RunnerPositions
                  key={r.id}
                  result={r}
                  color={PALETTE[i % PALETTE.length]}
                />
              ))}
            </div>
          </Panel>
        </>
      )}

      {!result && usable.length > 0 && (
        <Panel title="结果">
          <Empty>选择参赛模型后点击「开始对照」，即可横向比较谁更会赚钱。</Empty>
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
        <line
          x1={pad.left}
          x2={W - pad.right}
          y1={y(initialCash)}
          y2={y(initialCash)}
          className="baseline-line"
        />
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
                <td className="mono num">{p.quantity.toFixed(4)}</td>
                <td className="mono num dim">成本 {p.avgCost.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}