/**
 * 稳健性体检：把「这套参数靠不靠谱」摆在用户面前。
 *
 * 三块：
 * - 前推验证：样本内 vs 样本外收益，以及两者的落差（过拟合的直接证据）；
 * - 参数平台：最优参数周围是不是一片平台（尖峰 = 过拟合）；
 * - 多情景胜率：同一策略掷 N 条随机路径，正收益场景占比（只在模拟交易所）。
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

interface WinRateReport {
  scenarios: number;
  interval: string;
  barCount: number;
  symbols: string[];
  winRate: number;
  positiveRuns: number;
  flatRuns: number;
  negativeRuns: number;
  medianReturn: number;
  worstReturn: number;
  bestReturn: number;
  avgReturn: number;
  outcomes: { seed: number; returnPct: number; positive: boolean; maxDrawdownPct: number; fills: number }[];
  byRegime: {
    regime: string;
    runs: number;
    positiveRuns: number;
    flatRuns: number;
    medianReturn: number;
    worstReturn: number;
  }[];
  seed: number;
}

export function ValidationPanel({ store }: { store: AppStore }) {
  const symbols = useMemo(() => store.watchlist.map((w) => w.symbol), [store.watchlist]);
  const pool = store.watchlist.map((w) => w.symbol);
  const [folds, setFolds] = useState<FoldResult[] | null>(null);
  const [wfSummary, setWfSummary] = useState<{ avgOosReturn: number; avgGap: number; oosPositiveRatio: number } | null>(null);
  const [report, setReport] = useState<RobustnessReport | null>(null);
  const [winRate, setWinRate] = useState<WinRateReport | null>(null);
  const [busy, setBusy] = useState<"wf" | "rb" | "wr" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (which: "wf" | "rb" | "wr", seed?: number) => {
    setBusy(which);
    setError(null);
    try {
      if (which === "wf") {
        const d = await api.walkForward();
        setFolds(d.folds);
        setWfSummary({ avgOosReturn: d.avgOosReturn, avgGap: d.avgGap, oosPositiveRatio: d.oosPositiveRatio });
      } else if (which === "rb") {
        setReport(await api.robustness());
      } else {
        // 多情景胜率只在模拟交易所上有意义：它需要反复掷新的随机路径，
        // 真实行情给不出「不同场景」。取第一个模拟连接；没有就明确说不可用。
        const sim = store.connections.find((c) => c.adapterId === "simulated" && c.enabled);
        if (!sim) {
          setError("多情景胜率需要模拟交易所连接：它靠反复掷新的随机路径统计「多少场景盈利为正」，真实行情只有一条历史，给不出这个数。");
          return;
        }
        // 不传种子 = 掷新的一批路径；传了 = 用那颗起始种子复跑同一份报告
        setWinRate(
          await api.scenarioWinRate({
            connectionId: sim.id,
            scenarios: 24,
            ...(seed !== undefined ? { seed } : {}),
          }),
        );
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
          <Button small onClick={() => run("wr")} busy={busy === "wr"}>
            多情景胜率
          </Button>
        </div>
      }
    >
      <div className="hint-line">
        前推验证用「前一段数据的表现」预测「后一段」，落差越大说明参数越像是在拟合历史；
        参数平台则在 (快线, 慢线, 目标仓) 网格上扫一遍，最优点周围如果只有它自己好，就是过拟合；
        多情景胜率换一批随机路径，看「资金比本金多」的场景占几成。
      </div>
      {error && <Notice tone="error">{error}</Notice>}

      {winRate && (
        <div className="val-block">
          <div className="symbol-picker-head">多情景胜率（模拟交易所 · {winRate.scenarios} 条随机路径）</div>
          <Notice tone="error">
            这是在<b>本地生成的行情</b>上统计的：走向形状是编的、噪声是随机的。
            它回答「这套参数换个噪声还赚不赚、换个走向亏不亏」，不构成真实市场收益的预期。
          </Notice>
          <div className="grid-3" style={{ marginTop: 8 }}>
            <div className="stat-tile">
              <span className="stat-label">正收益场景占比（{winRate.scenarios} 条）</span>
              <span className={`stat-value mono ${winRate.winRate >= 0.5 ? "up" : "down"}`}>
                {pct(winRate.winRate)}
              </span>
              <span className="stat-note">
                正 {winRate.positiveRuns} · 保本 {winRate.flatRuns} · 亏 {winRate.negativeRuns}（期末资金 vs 本金）
              </span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">中位收益率</span>
              <span className={`stat-value mono ${winRate.medianReturn >= 0 ? "up" : "down"}`}>
                {pct(winRate.medianReturn)}
              </span>
              <span className="stat-note">典型一条路径的结果（比平均值诚实）</span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">最差一条</span>
              <span className={`stat-value mono ${winRate.worstReturn >= 0 ? "up" : "down"}`}>
                {pct(winRate.worstReturn)}
              </span>
              <span className="stat-note">运气最差时亏多少（费用已计入）</span>
            </div>
          </div>
          {winRate.byRegime.length > 0 && (
            <div className="table-scroll" style={{ marginTop: 8 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>走向（单独跑）</th>
                    <th className="num">正 / 保本 / 亏</th>
                    <th className="num">中位收益</th>
                    <th className="num">最差</th>
                  </tr>
                </thead>
                <tbody>
                  {winRate.byRegime.map((r) => (
                    <tr key={r.regime}>
                      <td>{r.regime}</td>
                      <td className="mono num">
                        {r.positiveRuns} / {r.flatRuns} / {r.runs - r.positiveRuns - r.flatRuns}
                      </td>
                      <td className={`mono num ${r.medianReturn >= 0 ? "up" : "down"}`}>{pct(r.medianReturn)}</td>
                      <td className={`mono num ${r.worstReturn >= 0 ? "up" : "down"}`}>{pct(r.worstReturn)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="small" style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span>
              以上面数字为组合口径：{winRate.symbols.join(" + ")} 一起跑。表格每行是该走向<b>单独</b>跑的成绩
              （同一批种子），组合里赚的钱不拆到各走向头上。保本 = 完全没成交、资金原封不动。
              买单只能用账上现金（现金账户，不透支），所以组合总敞口不会超过权益。
              {winRate.interval} · {winRate.barCount} 根/条 · 起始种子 {winRate.seed}。
            </span>
            <Button small onClick={() => run("wr", winRate.seed)} busy={busy === "wr"}>
              用种子 {winRate.seed} 复跑
            </Button>
            <span>再点上方「多情景胜率」则是换一批新路径。</span>
          </div>
        </div>
      )}

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
