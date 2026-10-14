/**
 * 因子与组合优化面板：让用户看得见、也调得动策略到底怎么算权重。
 */

import type { AppStore } from "../state/useAppStore";
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

      {cost.impactK > 0 && (
        <Notice tone="info">
          滑点 = 固定点差 + {cost.impactK}·波动率·√(订单占日成交额比)。订单越大、流动性越差，成交价越不利 —— 回测因此不再"高估小单、低估大单"。
        </Notice>
      )}
      {opt.targetVol > 0 && opt.method === "none" && (
        <Notice tone="warn">波动率目标只在 score / risk_parity 模式下生效。</Notice>
      )}
    </Panel>
  );
}

function factorWeights(partial: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of FACTOR_META) out[f.name] = partial?.[f.name] ?? f.defaultWeight;
  return out;
}
