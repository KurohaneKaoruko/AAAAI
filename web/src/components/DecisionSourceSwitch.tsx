/**
 * 智能体决策来源：三选一分段控件。
 *
 * 这是全局唯一的「谁在做决策」开关，放在策略页顶部常驻，
 * 不藏在任何 tab 里，并实时显示每个来源的可用实例数。
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

const OPTIONS: Option[] = [
  {
    value: "rules",
    label: "纯规则",
    desc: "动量策略本地计算，不调用任何模型。最快、最稳，零成本。",
  },
  {
    value: "chat",
    label: "对话模型",
    desc: "交给 OpenAI 兼容大模型决策，按负载均衡策略调度，失败自动回退规则。",
  },
  {
    value: "systemone",
    label: "决策模型",
    desc: "交给 System One 决策模型（Jev / Laya / 百炼），低延迟、输出结构化。",
  },
];

export function DecisionSourceSwitch({
  value,
  counts,
  busy,
  onChange,
}: {
  value: DecisionSource;
  counts: PoolCounts | null;
  busy: boolean;
  onChange: (v: DecisionSource) => void;
}) {
  const badge = (v: DecisionSource): string | null => {
    if (v === "rules" || !counts) return null;
    const pool = counts[v];
    if (pool.total === 0) return "未配置";
    return pool.available === 0 ? "无可用" : `${pool.available}/${pool.total} 可用`;
  };

  return (
    <div className="decision-switch">
      <div className="decision-switch-head">
        <span className="decision-switch-title">智能体决策来源</span>
        <span className="decision-switch-hint">决定由谁产生目标仓位，运行时立即生效</span>
      </div>
      <div className="decision-options" role="radiogroup" aria-label="智能体决策来源">
        {OPTIONS.map((o) => {
          const tag = badge(o.value);
          const on = value === o.value;
          const disabled = busy || (o.value !== "rules" && tag === "未配置");
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              className={`decision-option ${on ? "decision-on" : ""}`}
              disabled={disabled}
              title={o.value !== "rules" && tag === "未配置" ? "请先在「模型管理」页添加该类模型" : undefined}
              onClick={() => onChange(o.value)}
            >
              <span className="decision-label">
                {o.label}
                {tag && <span className={`decision-tag ${tag === "未配置" || tag === "无可用" ? "decision-tag-off" : ""}`}>{tag}</span>}
              </span>
              <span className="decision-desc">{o.desc}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}