/**
 * 因子与组合优化面板：让用户看得见、也调得动策略到底怎么算权重。
 */

import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppStore } from "../state/useAppStore";
import type { Bot } from "../types";
import { Notice, NumberField, Panel, SelectField } from "./ui";
import { pct } from "../lib/format";
import { FACTOR_META } from "../../../src/factors/meta";

export function OptimizePanel({ store }: { store: AppStore }) {
  const cfg = store.state?.config;
  const opt = cfg?.optimize;
  const cost = cfg?.cost;
  if (!opt || !cost) return null;

  const save = (patch: Partial<typeof opt>) =>
    void store.patchConfig({ optimize: { ...opt, ...patch } } as never);

  const weights = { ...factorWeights(opt.factorWeights) };
  // 只有真正用到协方差矩阵的模式才显示这个选项；否则它会是个「勾了没用」的死开关
  const usesCovariance = opt.method === "risk_parity" || opt.targetVol > 0;

  return (
    <Panel title="因子与组合优化" subtitle="规则路径怎么算权重">
      <SelectField
        label="权重生成方式"
        value={opt.method}
        options={[
          { value: "score", label: "因子分加权（默认）" },
          { value: "risk_parity", label: "分层风险平价 HRP（考虑相关性）" },
          { value: "none", label: "不优化（因子分直接给权重）" },
        ]}
        onChange={(v) => save({ method: v as typeof opt.method })}
      />
      <div className="hint-line">
        {opt.method === "risk_parity"
          ? "HRP：先按相关性把资产聚类，簇内与簇间都按 1/方差分配权重 —— 波动大的自动减仓，且不会因为两个资产高度相关而误以为分散。"
          : opt.method === "score"
            ? "各因子在候选池内做 z-score 标准化后加权，量纲统一，排名不会被单一指标的量级带偏。"
            : "关闭优化：因子分最高者拿满权重，其余按比例。"}
        {" "}AI 自主配置（对话模型/决策模型/混合）时这些只作用于风险敞口，不改模型的持仓方向。
      </div>

      <div className="factor-grid">
        {FACTOR_META.map((f) => (
          <div className="factor-row" key={f.name}>
            <span className="factor-name">{f.label}</span>
            <span className="factor-desc dim small">{f.desc}</span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={weights[f.name] ?? 0}
              onChange={(e) =>
                save({ factorWeights: { ...weights, [f.name]: Number(e.target.value) } })
              }
            />
            <span className="factor-w mono">{(weights[f.name] ?? 0).toFixed(1)}</span>
          </div>
        ))}
      </div>

      <div className="grid-3">
        <NumberField
          label="目标年化波动率"
          hint={opt.targetVol > 0 ? `拉到 ${pct(opt.targetVol, 0)}（不加杠杆）` : "不启用"}
          value={opt.targetVol}
          step={0.01}
          min={0}
          max={1}
          onChange={(v) => save({ targetVol: v })}
        />
        <NumberField
          label="最少保留标的"
          value={opt.minPositions}
          min={0}
          max={10}
          onChange={(v) => save({ minPositions: v })}
        />
        <NumberField
          label="冲击成本系数"
          hint={cost.impactK > 0 ? "大单会自动更贵" : "仅固定滑点"}
          value={cost.impactK}
          step={0.05}
          min={0}
          max={1}
          onChange={(v) => void store.patchConfig({ cost: { ...cost, impactK: v } } as never)}
        />
      </div>

      {usesCovariance && (
        <SelectField
          label="协方差估计"
          value={opt.covariance}
          options={[
            { value: "lw", label: "Ledoit-Wolf 收缩（样本少时更稳）" },
            { value: "sample", label: "原始样本协方差" },
          ]}
          onChange={(v) => save({ covariance: v as "sample" | "lw" })}
        />
      )}
      {usesCovariance && (
        <div className="hint-line">
          {opt.covariance === "lw"
            ? "收缩只压相关系数、保留各方差：样本少时成对相关性几乎全是噪声，压掉它能降低估计误差，并且在收缩强度 λ>0 时让协方差矩阵恢复正定（原始样本协方差在资产高度相关时可能是奇异的）。"
            : "直接用样本协方差：样本足够多时更「忠实」，但样本少或资产高度相关时结果会明显跑偏。"}
        </div>
      )}

      {cost.impactK > 0 && (
        <Notice tone="info">
          滑点 = 固定点差 + {cost.impactK}·波动率·√(订单占日成交额比)。订单越大、流动性越差，成交价越不利 —— 回测因此不再"高估小单、低估大单"。
        </Notice>
      )}
      {opt.targetVol > 0 && opt.method === "none" && (
        <Notice tone="warn">波动率目标只在 score / risk_parity 模式下生效。</Notice>
      )}

      <ExecutionSlicing store={store} />
    </Panel>
  );
}

/**
 * 拆单执行（TWAP/VWAP）。
 *
 * 只在 paper 模式下有意义：live 模式走交易所原生订单，本地切片器不介入。
 * 关闭时明确说明「不会改变任何成交结果」，免得看起来像个勾了有影响的开关。
 */
function ExecutionSlicing({ store }: { store: AppStore }) {
  const exec = store.state?.config?.execution;
  if (!exec) return null;
  const on = exec.slicingAlgo !== "none";

  const save = (patch: Partial<typeof exec>) =>
    void store.patchConfig({ execution: { ...exec, ...patch } } as never);

  return (
    <>
      <div className="hint-line" style={{ marginTop: 16, marginBottom: 6, color: "var(--text)", fontWeight: 600 }}>
        拆单执行
        <span className="dim small" style={{ marginLeft: 8, fontWeight: 400 }}>
          大单分批成交，降低冲击成本
        </span>
      </div>
      {exec.mode === "live" && (
        <Notice tone="warn">
          当前是 live 模式：下单走交易所原生订单，本地拆单器不介入。这里改动仅对 paper 回测/模拟生效。
        </Notice>
      )}
      <div className="grid-2">
        <SelectField
          label="执行算法"
          value={exec.slicingAlgo}
          options={[
            { value: "none", label: "不拆（一次性成交）" },
            { value: "twap", label: "TWAP 按时间等量切片" },
            { value: "vwap", label: "VWAP 按历史量能分配" },
          ]}
          onChange={(v) => save({ slicingAlgo: v as typeof exec.slicingAlgo })}
        />
        {on && (
          <NumberField
            label="切片数"
            value={exec.slicingSlices}
            min={2}
            max={24}
            onChange={(v) => save({ slicingSlices: v })}
          />
        )}
        {on && (
          <NumberField
            label="切片间隔（根）"
            value={exec.slicingSpacingBars}
            min={1}
            max={24}
            onChange={(v) => save({ slicingSpacingBars: v })}
          />
        )}
      </div>
      <div className="hint-line">
        {exec.slicingAlgo === "none"
          ? "关闭：整笔单按当前价一次性成交，与之前的结果完全一致。"
          : exec.slicingAlgo === "twap"
            ? `TWAP：整笔单平均分成 ${exec.slicingSlices} 片，每 ${exec.slicingSpacingBars} 根 K 线成交一片。每片各算各的冲击成本，总冲击约降到 1/√${exec.slicingSlices}。`
            : `VWAP：权重来自最近 ${exec.slicingVolumeProfileBars} 根 K 线的成交量分布（只用已观测到的量，不用未来数据），尽量在活跃时段成交。`}
        {" "}拆单只改执行不改信号 —— 整笔单仍会执行完，不会因为拆单而少买少卖。
      </div>
      {on && (
        <Notice tone="info">
          基础点差按成交金额比例计费，拆单不会额外增加它；省下的是冲击项，而冲击 ∝ 订单占日成交额的比例 ——
          所以小单拆了也几乎不省，只有大单（占日成交额 10% 以上）才值得拆。
        </Notice>
      )}
      <SlicingStats store={store} />
    </>
  );
}

/**
 * 实际执行统计。
 *
 * 数据源是**机器人**：单账户引擎删除后，拆单只发生在机器人里，
 * 所以统计必须跟着机器人走，否则这里会变成一个永远空的图表。
 */
function SlicingStats({ store }: { store: AppStore }) {
  const [rows, setRows] = useState<Bot[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await api.bots();
        if (alive) setRows(d.bots);
      } catch {
        /* 忽略 */
      }
    };
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const active = rows.filter((b) => b.slicing);
  if (active.length === 0) return null;
  const completed = active.reduce((a, b) => a + (b.slicing?.completed ?? 0), 0);
  const pending = active.reduce((a, b) => a + (b.slicing?.pending ?? 0), 0);
  const shortfall =
    active.reduce((a, b) => a + (b.slicing?.completed ?? 0) * (b.slicing?.avgShortfallBps ?? 0), 0) /
    Math.max(1, completed);

  return (
    <>
      <div className="grid-2">
        <div className="stat-tile">
          <span className="stat-label">已完成拆单</span>
          <strong>{completed} 笔</strong>
          <span className="stat-note">
            {pending > 0
              ? `进行中 ${pending} 笔（数据结束时未到期的切片，按未成交计入，不假装成交）`
              : `来自 ${active.length} 个机器人`}
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">平均实施短缺</span>
          <strong>{shortfall.toFixed(1)} bps</strong>
          <span className="stat-note">正数 = 拆单期间多付（含手续费），负数 = 省下</span>
        </div>
      </div>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>机器人</th>
              <th>算法</th>
              <th className="num">已完成</th>
              <th className="num">进行中</th>
              <th className="num">实施短缺</th>
            </tr>
          </thead>
          <tbody>
            {active.map((b) => (
              <tr key={b.id}>
                <td>{b.name}</td>
                <td>{b.slicing!.algo.toUpperCase()} · {b.slicing!.slices} 片</td>
                <td className="num mono">{b.slicing!.completed}</td>
                <td className="num mono">{b.slicing!.pending}</td>
                <td
                  className="num mono"
                  style={{ color: b.slicing!.avgShortfallBps > 0 ? "var(--notice-warn-text)" : "var(--notice-ok-text)" }}
                >
                  {b.slicing!.avgShortfallBps.toFixed(1)} bps
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function factorWeights(partial: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of FACTOR_META) out[f.name] = partial?.[f.name] ?? f.defaultWeight;
  return out;
}
