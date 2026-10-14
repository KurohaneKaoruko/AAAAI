/**
 * 智能体决策来源：可多选，按配比融合（混合决策）。
 *
 * 这是全局唯一的「谁在做决策」开关，放在策略页顶部常驻：
 * - 只勾「纯规则」= 老样子，零成本；
 * - 勾「对话模型 + 决策模型」= 混合决策，两路各出权重后按配比融合；
 * - 勾多路但某类模型没配实例，该路自动退出，配比让给其余路（页面会提前标出来）。
 */

import type { DecisionSource } from "../types";

export interface PoolCounts {
  chat: { total: number; available: number };
  systemone: { total: number; available: number };
}

interface Option {
  value: DecisionSource;
  label: string;
  desc: string;
}

export const SOURCE_OPTIONS: Option[] = [
  {
    value: "rules",
    label: "纯规则",
    desc: "双均线动量本地计算，不调用任何模型。最快、最稳、零成本。",
  },
  {
    value: "chat",
    label: "对话模型",
    desc: "OpenAI 兼容大模型，按负载均衡调度，失败自动回退规则。",
  },
  {
    value: "systemone",
    label: "决策模型",
    desc: "System One（Jev / Laya / 百炼），低延迟、结构化输出。",
  },
];

export const SOURCE_ZH: Record<DecisionSource, string> = {
  rules: "纯规则",
  chat: "对话模型",
  systemone: "决策模型",
};

/** 归一化后的配比（%），用于展示。 */
export function ratioPct(
  sources: DecisionSource[],
  blend: Record<DecisionSource, number>,
): { source: DecisionSource; pct: number }[] {
  const total = sources.reduce((acc, s) => acc + (blend[s] ?? 0), 0) || 1;
  return sources.map((s) => ({ source: s, pct: Math.round(((blend[s] ?? 0) / total) * 100) }));
}

export function DecisionSourceSwitch({
  sources,
  blend,
  counts,
  busy,
  onChange,
}: {
  sources: DecisionSource[];
  blend: Record<DecisionSource, number>;
  counts: PoolCounts | null;
  busy: boolean;
  onChange: (next: { sources: DecisionSource[]; blend: Record<DecisionSource, number> }) => void;
}) {
  const badge = (v: DecisionSource): string | null => {
    if (v === "rules" || !counts) return null;
    const pool = counts[v];
    if (pool.total === 0) return "未配置";
    return pool.available === 0 ? "无可用" : `${pool.available}/${pool.total} 可用`;
  };

  const active: DecisionSource[] = sources.length > 0 ? sources : ["rules"];
  const total: number = active.reduce((acc, s) => acc + (blend[s] ?? 0), 0) || 1;

  const toggle = (v: DecisionSource) => {
    const on = active.includes(v);
    if (on && active.length === 1) return; // 至少留一路
    const nextSources = on ? active.filter((s) => s !== v) : [...active, v];
    const nextBlend = { ...blend };
    if (!on) nextBlend[v] = nextBlend[v] > 0 ? nextBlend[v] : 1; // 新勾选的默认给 1
    if (on) nextBlend[v] = 0;
    onChange({ sources: nextSources, blend: nextBlend });
  };

  // 配比存相对权重，展示时才归一成百分比；只有一路时配比无意义，不给调。
  const setRatio = (v: DecisionSource, raw: number) => {
    if (active.length < 2) return;
    const value = Math.max(0, Math.min(10, Math.round(raw)));
    if (value === (blend[v] ?? 0)) return;
    onChange({ sources: active, blend: { ...blend, [v]: value } });
  };

  return (
    <div className="decision-switch">
      <div className="decision-switch-head">
        <span className="decision-switch-title">智能体决策来源</span>
        <span className="decision-switch-hint">
          可多选并按配比融合（混合决策），运行时立即生效
        </span>
      </div>
      <div className="decision-options" role="group" aria-label="智能体决策来源">
        {SOURCE_OPTIONS.map((o) => {
          const tag = badge(o.value);
          const on = active.includes(o.value);
          const missing = o.value !== "rules" && tag === "未配置";
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              className={`decision-option ${on ? "decision-on" : ""}`}
              disabled={busy}
              title={missing ? "请先在「模型管理」页添加该类模型；不勾也可勾选，系统会自动把它的配比让给其他路" : undefined}
              onClick={() => toggle(o.value)}
            >
              <span className="decision-label">
                {o.label}
                {tag && (
                  <span className={`decision-tag ${tag === "未配置" || tag === "无可用" ? "decision-tag-off" : ""}`}>
                    {tag}
                  </span>
                )}
              </span>
              <span className="decision-desc">{o.desc}</span>
            </button>
          );
        })}
      </div>

      {active.length > 1 && (
        <div className="blend-rows">
          <div className="blend-title">
            融合配比（按权重线性加权；某路无实例或失败时，其配比自动让给其余路）
          </div>
          {active.map((s) => {
            const pctValue = Math.round(((blend[s] ?? 0) / total) * 100);
            const pool = s === "rules" ? null : counts?.[s];
            const offline = pool ? pool.available === 0 : false;
            return (
              <div className="blend-row" key={s}>
                <span className="blend-name">{SOURCE_ZH[s]}</span>
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={blend[s] ?? 0}
                  disabled={busy}
                  onChange={(e) => setRatio(s, Number(e.target.value))}
                />
                <span className="blend-pct mono">{pctValue}%</span>
                {offline && <span className="blend-warn">无可用实例 · 自动让位</span>}
              </div>
            );
          })}
          <div className="blend-preview small dim">
            例：对话模型 {ratioPct(active, blend).find((r) => r.source === "chat")?.pct ?? 0}% +
            决策模型 {ratioPct(active, blend).find((r) => r.source === "systemone")?.pct ?? 0}% →
            最终目标仓位 = 各自权重按上述比例相加
          </div>
        </div>
      )}
    </div>
  );
}