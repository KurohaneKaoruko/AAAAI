/**
 * 稳健性体检：把「这套参数靠不靠谱」摆在用户面前。
 *
 * 两块：
 * - 前推验证：样本内 vs 样本外收益，以及两者的落差（过拟合的直接证据）；
 * - 参数平台：最优参数周围是不是一片平台（尖峰 = 过拟合）。
 *
 * 这些都只做评估与展示，不改参数、不参与交易。
 */

import { useState } from "react";
import { api } from "../api";
import type { AppStore } from "../state/useAppStore";
import { Button, Empty, Notice, Panel } from "./ui";
import { pct } from "../lib/format";

interface FoldResult {
  fold: number;
  isBars: number;
  oosBars: number;
  isReturn: number;
  oosReturn: number;
  oosFills: number;
  gap: number;
}

interface RobustnessReport {
  best: { fast: number; slow: number; targetWeight: number; returnPct: number; drawdown: number } | null;
  median: number;
  plateauRatio: number;
  overfitRisk: boolean;
  cells: { fast: number; slow: number; targetWeight: number; returnPct: number; drawdown: number }[];
}

export function ValidationPanel({ store }: { store: AppStore }) {
  const symbols = store.state?.symbols ?? [];
  const pool = store.watchlist.map((w) => w.symbol);
  const [folds, setFolds] = useState<FoldResult[] | null>(null);
  const [wfSummary, setWfSummary] = useState<{ avgOosReturn: number; avgGap: number; oosPositiveRatio: number } | null>(null);
  const [report, setReport] = useState<RobustnessReport | null>(null);
  const [busy, setBusy] = useState<"wf" | "rb" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (which: "wf" | "rb") => {
    setBusy(which);
    setError(null);
    try {
      if (which === "wf") {
        const d = await api.walkForward();
        setFolds(d.folds);
        setWfSummary({ avgOosReturn: d.avgOosReturn, avgGap: d.avgGap, oosPositiveRatio: d.oosPositiveRatio });
      } else {
        setReport(await api.robustness());
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title="稳健性体检"
      subtitle="参数是在同一段数据上挑的，收益也在这段数据上评 —— 这里看的是落差"
      actions={
        <div className="btn-row" style={{ margin: 0 }}>
          <Button small onClick={() => run("wf")} busy={busy === "wf"} disabled={symbols.length === 0 && pool.length === 0}>
            前推验证
          </Button>
          <Button small onClick={() => run("rb")} busy={busy === "rb"} disabled={symbols.length === 0 && pool.length === 0}>
            参数平台
          </Button>
        </div>
      }
    >
      <div className="hint-line">
        前推验证用「前一段数据的表现」预测「后一段」，落差越大说明参数越像是在拟合历史；
        参数平台则在 (快线, 慢线, 目标仓) 网格上扫一遍，最优点周围如果只有它自己好，就是过拟合。
      </div>
      {error && <Notice tone="error">{error}</Notice>}

      {folds && (
        <div className="val-block">
          <div className="symbol-picker-head">前推验证（样本内 → 样本外）</div>
          {folds.length === 0 ? (
            <Empty>历史数据太短，至少需要两折窗口</Empty>
          ) : (
            <>
              <div className="grid-3">
                <div className="stat-tile">
                  <span className="stat-label">样本外平均收益</span>
                  <span className={`stat-value mono ${wfSummary!.avgOosReturn >= 0 ? "up" : "down"}`}>
                    {pct(wfSummary!.avgOosReturn, 2)}
                  </span>
                </div>
                <div className="stat-tile">
                  <span className="stat-label">平均落差（IS-OOS）</span>
                  <span className={`stat-value mono ${Math.abs(wfSummary!.avgGap) < 0.02 ? "" : "down"}`}>
                    {pct(wfSummary!.avgGap, 2)}
                  </span>
                  <span className="stat-note">
                    {Math.abs(wfSummary!.avgGap) < 0.02 ? "落差很小：较可信" : "落差偏大：警惕过拟合"}
                  </span>
                </div>
                <div className="stat-tile">
                  <span className="stat-label">样本外为正的比例</span>
                  <span className="stat-value mono">{pct(wfSummary!.oosPositiveRatio, 0)}</span>
                </div>
              </div>
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>折</th>
                      <th className="num">样本内</th>
                      <th className="num">样本外</th>
                      <th className="num">落差</th>
                      <th className="num">样本外成交</th>
                    </tr>
                  </thead>
                  <tbody>
                    {folds.map((f) => (
                      <tr key={f.fold}>
                        <td>第 {f.fold} 折</td>
                        <td className={`mono num ${f.isReturn >= 0 ? "up" : "down"}`}>{pct(f.isReturn, 2)}</td>
                        <td className={`mono num ${f.oosReturn >= 0 ? "up" : "down"}`}>{pct(f.oosReturn, 2)}</td>
                        <td className={`mono num ${f.gap > 0.02 ? "down" : ""}`}>{pct(f.gap, 2)}</td>
                        <td className="mono num dim">{f.oosFills}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {report && (
        <div className="val-block">
          <div className="symbol-picker-head">参数平台</div>
          {!report.best ? (
            <Empty>网格里没有有效组合</Empty>
          ) : (
            <>
              <div className="grid-3">
                <div className="stat-tile">
                  <span className="stat-label">网格最佳</span>
                  <span className="stat-value mono">
                    {report.best.fast}/{report.best.slow}@{pct(report.best.targetWeight, 0)}
                  </span>
                  <span className="stat-note">
                    收益 {pct(report.best.returnPct, 2)} · 回撤 {pct(report.best.drawdown, 2)}
                  </span>
                </div>
                <div className="stat-tile">
                  <span className="stat-label">全网格中位数</span>
                  <span className="stat-value mono">{pct(report.median, 2)}</span>
                  <span className="stat-note">最佳与中位数的差距越小越真实</span>
                </div>
                <div className="stat-tile">
                  <span className="stat-label">平台占比</span>
                  <span className="stat-value mono">{pct(report.plateauRatio, 0)}</span>
                  <span className="stat-note">
                    {report.overfitRisk ? "尖峰：过拟合风险高" : "成片：信号相对稳健"}
                  </span>
                </div>
              </div>
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>快线</th>
                      <th>慢线</th>
                      <th className="num">目标仓</th>
                      <th className="num">收益</th>
                      <th className="num">回撤</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...report.cells]
                      .sort((a, b) => b.returnPct - a.returnPct)
                      .map((c) => (
                        <tr
                          key={`${c.fast}-${c.slow}-${c.targetWeight}`}
                          className={c === report.best ? "row-best" : ""}
                        >
                          <td className="mono">{c.fast}</td>
                          <td className="mono">{c.slow}</td>
                          <td className="mono num">{pct(c.targetWeight, 0)}</td>
                          <td className={`mono num ${c.returnPct >= 0 ? "up" : "down"}`}>{pct(c.returnPct, 2)}</td>
                          <td className="mono num dim">{pct(c.drawdown, 2)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}