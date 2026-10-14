/**
 * 自我进化面板：开关、学习统计、变更日志与回滚。
 *
 * 措辞上刻意保守：系统只会「有界地微调少数搜索参数」，
 * 风控上限类参数不会被自动放宽；默认关闭。
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AppStore } from "../state/useAppStore";
import type { EvolutionView } from "../types";
import { Button, Empty, Notice, Panel, Toggle } from "./ui";
import { dateTime, pct } from "../lib/format";

const PARAM_ZH: Record<string, string> = {
  "strategy.fastWindow": "快线窗口",
  "strategy.slowWindow": "慢线窗口",
  "strategy.maxTargetWeight": "目标仓上限",
  "risk.minTradeValue": "最小调仓额",
};

function fmtValue(param: string, v: unknown): string {
  if (typeof v !== "number") return String(v);
  if (param === "strategy.maxTargetWeight") return pct(v, 0);
  return String(Math.round(v));
}

export function EvolutionPanel({ store }: { store: AppStore }) {
  const cfg = store.state?.config?.evolution;
  const [view, setView] = useState<EvolutionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setView(await api.evolution());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 10_000);
    return () => clearInterval(t);
  }, [reload]);

  if (!cfg) return null;

  const save = async (patch: Partial<typeof cfg>) => {
    try {
      await store.patchConfig({ evolution: { ...cfg, ...patch } } as never);
    } catch (err) {
      store.toast("error", (err as Error).message);
    }
  };

  const evaluate = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.evaluateEvolution(true);
      setView(r.view);
      store.toast(
        r.applied.length > 0 ? "success" : "info",
        r.applied.length > 0 ? `已调整 ${r.applied.length} 个参数（下次运行生效）` : "本次没有需要调整的参数",
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rollback = async () => {
    setBusy(true);
    try {
      const r = await api.rollbackEvolution();
      setView(r.view);
      store.toast(r.reverted ? "success" : "info", r.reverted ? "已回滚上一次调整" : "没有可回滚的调整");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const s = view?.stats;

  return (
    <Panel
      title="自我进化"
      subtitle="从自己的决策结果里学习，有界地微调参数"
      actions={
        <div className="btn-row" style={{ margin: 0 }}>
          <Button small onClick={evaluate} busy={busy} disabled={!cfg.enabled}>
            立即评估
          </Button>
          <Button small variant="ghost" onClick={rollback} disabled={busy || !view?.changelog.some((c) => !c.reverted)}>
            回滚上次
          </Button>
        </div>
      }
    >
      <Toggle
        label="启用自我进化（会自动微调策略参数：快慢线、目标仓上限、最小调仓额）"
        checked={cfg.enabled}
        onChange={(v) => void save({ enabled: v })}
      />
      <div className="hint-line">
        风控上限（回撤熔断、单笔金额上限、单标的仓位上限）永远不会被自动放宽；每次调整都有幅度上限、冷却时间与变更日志，可一键回滚。
      </div>

      {cfg.enabled && (
        <div className="grid-3">
          <div className="stat-tile">
            <span className="stat-label">已结算决策</span>
            <span className="stat-value mono">
              {s?.settled ?? 0}
              <em className="dim">/{cfg.minSamples}</em>
            </span>
            {(s?.samplesNeeded ?? 0) > 0 && <span className="stat-note">还差 {s?.samplesNeeded} 笔才开始调参</span>}
          </div>
          <div className="stat-tile">
            <span className="stat-label">平均超额（对等权基准）</span>
            <span className={`stat-value mono ${(s?.avgAlpha ?? 0) >= 0 ? "up" : "down"}`}>
              {pct(s?.avgAlpha ?? 0, 2)}
            </span>
          </div>
          <div className="stat-tile">
            <span className="stat-label">跑赢基准比例</span>
            <span className="stat-value mono">{pct(s?.beatRate ?? 0, 0)}</span>
            {s?.bestSymbol && <span className="stat-note">最好：{s.bestSymbol}（{pct(s.bestSymbolAlpha, 2)}）</span>}
          </div>
        </div>
      )}

      {cfg.enabled && s?.cooldownUntil && (
        <Notice tone="info">冷却中：{dateTime(s.cooldownUntil)} 之前不会再自动调整。</Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      {cfg.enabled && (
        <div className="grid-3">
          <div className="stat-inline">
            结算窗口 <b className="mono">{cfg.horizonBars}</b> 根 K 线
          </div>
          <div className="stat-inline">
            单次最大变动 <b className="mono">{pct(cfg.maxChangeRatio, 0)}</b>
          </div>
          <div className="stat-inline">
            评估间隔 <b className="mono">{Math.round(cfg.evaluateMs / 60000)}</b> 分钟
          </div>
        </div>
      )}

      <div className="evo-log">
        <div className="symbol-picker-head">变更日志（{view?.changelog.length ?? 0}）</div>
        {!view || view.changelog.length === 0 ? (
          <Empty>还没有调整过参数</Empty>
        ) : (
          view.changelog.slice(0, 20).map((c, i) => (
            <div className={`evo-row ${c.reverted ? "evo-reverted" : ""}`} key={`${c.at}-${i}`}>
              <span className="mono small dim">{dateTime(c.at)}</span>
              <span className="evo-param">{PARAM_ZH[c.param] ?? c.param}</span>
              <span className="mono">
                {fmtValue(c.param, c.before)} → <b>{fmtValue(c.param, c.after)}</b>
              </span>
              <span className="evo-reason">{c.reason}</span>
              {c.reverted && <span className="chip chip-sm">已回滚</span>}
            </div>
          ))
        )}
      </div>

      {view && view.recentDecisions.length > 0 && (
        <details className="manual-add">
          <summary>最近决策与结算结果（{view.recentDecisions.length}）</summary>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>来源</th>
                  <th>标的</th>
                  <th className="num">收益</th>
                  <th className="num">超额</th>
                  <th className="num">最大不利</th>
                </tr>
              </thead>
              <tbody>
                {view.recentDecisions.slice(0, 20).map((d) => (
                  <tr key={d.id}>
                    <td className="mono small dim">{dateTime(d.at)}</td>
                    <td>{d.source}</td>
                    <td className="mono small">{d.symbols.join(", ") || "空仓"}</td>
                    <td className={`mono num ${(d.outcome?.returnPct ?? 0) >= 0 ? "up" : "down"}`}>
                      {d.outcome ? pct(d.outcome.returnPct, 2) : "待结算"}
                    </td>
                    <td className={`mono num ${(d.outcome?.alpha ?? 0) >= 0 ? "up" : "down"}`}>
                      {d.outcome ? pct(d.outcome.alpha, 2) : "—"}
                    </td>
                    <td className="mono num dim">{d.outcome ? pct(d.outcome.maxAdverse, 2) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </Panel>
  );
}