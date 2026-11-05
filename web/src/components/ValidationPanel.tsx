/**
 * 稳健性体检：把「这套参数靠不靠谱」摆在用户面前。
 *
 * 两块：
 * - 前推验证：样本内 vs 样本外收益，以及两者的落差（过拟合的直接证据）；
 * - 参数平台：最优参数周围是不是一片平台（尖峰 = 过拟合）。
 *
 * 多情景胜率依赖「反复掷随机路径」，模拟行情下线后真实行情只有一条历史，
 * 服务端也删掉了对应接口，所以这里不再提供。
 *
 * 这些都只做评估与展示，不改参数、不参与交易。
 */

import { useMemo, useState } from "react";
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
  const symbols = useMemo(() => store.watchlist.map((w) => w.symbol), [store.watchlist]);
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
        两项都基于真实历史行情，只做评估，不改参数。
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
                    {pct(wfSummary!.avgOosReturn)}
                  </span>
                </div>
                <div className="stat-tile">
                  <span className="stat-label">样本外为正的折数占比</span>
                  <span className="stat-value mono">{pct(wfSummary!.oosPositiveRatio)}</span>
                </div>
                <div className="stat-tile">
                  <span className="stat-label">样本内外落差</span>
                  <span className={`stat-value mono ${wfSummary!.avgGap >= 0 ? "up" : "down"}`}>
                    {pct(wfSummary!.avgGap)}
                  </span>
                </div>
              </div>
              <div className="table-scroll" style={{ marginTop: 8 }}>
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
                        <td>#{f.fold}</td>
                        <td className={`mono num ${f.isReturn >= 0 ? "up" : "down"}`}>{pct(f.isReturn)}</td>
                        <td className={`mono num ${f.oosReturn >= 0 ? "up" : "down"}`}>{pct(f.oosReturn)}</td>
                        <td className={`mono num ${f.gap >= 0 ? "up" : "down"}`}>{pct(f.gap)}</td>
                        <td className="mono num">{f.oosFills}</td>
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
          <div className="symbol-picker-head">参数平台（{(report.best?.fast ?? 0)}/{(report.best?.slow ?? 0)} 周围）</div>
          {report.overfitRisk && (
            <Notice tone="error">
              最优参数周围只有它自己好：这种「尖峰」参数大概率是拟合了这段历史的噪声，换段行情就垮。
            </Notice>
          )}
          {!report.best && <Empty>网格里没有一个格子赚钱，谈不上平台</Empty>}
          {report.best && report.cells.length > 0 && (
            <div className="table-scroll" style={{ marginTop: 8 }}>
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
                  {report.cells.map((c) => (
                    <tr
                      key={`${c.fast}-${c.slow}-${c.targetWeight}`}
                      className={c.fast === report.best?.fast && c.slow === report.best?.slow ? "row-best" : ""}
                    >
                      <td className="mono">{c.fast}</td>
                      <td className="mono">{c.slow}</td>
                      <td className="mono num">{pct(c.targetWeight)}</td>
                      <td className={`mono num ${c.returnPct >= 0 ? "up" : "down"}`}>{pct(c.returnPct)}</td>
                      <td className="mono num">{pct(c.drawdown)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
