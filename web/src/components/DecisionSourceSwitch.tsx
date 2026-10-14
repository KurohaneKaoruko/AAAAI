/**
 * 智能体决策来源：四选一，其中「混合决策」是独立设计的一条流水线。
 *
 *   纯规则     本地双均线动量，不调模型
 *   对话模型   大模型直接给每个标的的目标仓位
 *   决策模型   System One 逐标的定档位，档位概率换算仓位
 *   混合决策   大模型分析行情 → 决策模型拿分析做仓位决策（职责分离，不投票）
 *
 * 原则：不做「勾了却没用」的死选项——没配模型实例的类型直接禁用并说明原因。
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
  { value: "rules", label: "纯规则", desc: "双均线动量本地计算，不调用任何模型。最快、最稳、零成本。" },
  { value: "chat", label: "对话模型", desc: "大模型看行情后，直接给出每个标的的目标仓位。" },
  { value: "systemone", label: "决策模型", desc: "System One（Jev / Laya / 百炼）逐标的定档位，低延迟。" },
  {
    value: "hybrid",
    label: "混合决策",
    desc: "大模型只做行情分析（不给仓位），决策模型拿这份分析定仓位。两步各司其职，不投票。",
  },
];

export const SOURCE_ZH: Record<DecisionSource, string> = {
  rules: "纯规则",
  chat: "对话模型",
  systemone: "决策模型",
  hybrid: "混合决策",
};

/** 分析影响力滑杆的档位说明。 */
const INFLUENCE_STEPS = [
  { v: 0, label: "不参考", hint: "决策模型看不到分析，完全独立决策" },
  { v: 30, label: "弱参考", hint: "分析结论作为附带参考" },
  { v: 60, label: "重要参考", hint: "分析结论是重要依据，冲突时以决策模型为准" },
  { v: 100, label: "主要依据", hint: "决策模型以分析结论为主要依据" },
];

export function DecisionSourceSwitch({
  value,
  influence,
  counts,
  busy,
  onChange,
}: {
  value: DecisionSource;
  influence: number;
  counts: PoolCounts | null;
  busy: boolean;
  onChange: (next: { source: DecisionSource; influence: number }) => void;
}) {
  const ready = (v: DecisionSource): boolean => {
    if (v === "rules") return true;
    if (v === "hybrid") return ready("chat") && ready("systemone");
    const pool = counts?.[v];
    return Boolean(pool && pool.total > 0 && pool.available > 0);
  };

  const step = INFLUENCE_STEPS.reduce((best, s) =>
    Math.abs(s.v - influence) < Math.abs(best.v - influence) ? s : best,
  );

  return (
    <div className="decision-switch">
      <div className="decision-switch-head">
        <span className="decision-switch-title">智能体决策来源</span>
        <span className="decision-switch-hint">决定由谁产生目标仓位，运行时立即生效</span>
      </div>
      <div className="decision-options" role="radiogroup" aria-label="智能体决策来源">
        {OPTIONS.map((o) => {
          const on = value === o.value;
          const enabled = ready(o.value);
          const pool = o.value === "chat" || o.value === "systemone" ? counts?.[o.value] : null;
          const tag =
            o.value === "hybrid"
              ? !ready("chat")
                ? "缺对话模型"
                : !ready("systemone")
                  ? "缺决策模型"
                  : "可用"
              : o.value === "rules"
                ? null
                : !pool || pool.total === 0
                  ? "未配置"
                  : pool.available === 0
                    ? "无可用"
                    : `${pool.available}/${pool.total} 可用`;
          const tagOff = tag !== null && tag !== "可用" && !/可用$/.test(tag ?? "");
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              className={`decision-option ${on ? "decision-on" : ""}`}
              disabled={busy || !enabled}
              title={!enabled ? hint(o.value, counts) : undefined}
              onClick={() => onChange({ source: o.value, influence })}
            >
              <span className="decision-label">
                {o.label}
                {tag && <span className={`decision-tag ${tagOff ? "decision-tag-off" : ""}`}>{tag}</span>}
              </span>
              <span className="decision-desc">{o.desc}</span>
            </button>
          );
        })}
      </div>

      {value === "hybrid" && (
        <div className="blend-rows">
          <div className="blend-title">
            分析影响力：<b>{step.label}</b> <span className="dim">· {step.hint}</span>
          </div>
          <div className="blend-row">
            <span className="blend-name">影响力</span>
            <input
              type="range"
              min={0}
              max={100}
              step={10}
              disabled={busy}
              value={influence}
              onChange={(e) => onChange({ source: value, influence: Number(e.target.value) / 100 })}
            />
            <span className="blend-pct mono">{Math.round(influence * 100)}%</span>
          </div>
          <div className="blend-preview small dim">
            流程：对话模型输出「怎么看」→ System One 读到这份分析后逐标的定档位 → 档位概率换算成目标仓位。
            决策模型掉线时自动按分析的强弱换算；分析掉线时决策模型独立决策。
          </div>
        </div>
      )}
    </div>
  );
}

/** 没配模型时给出的具体指引，而不是让用户猜。 */
function hint(v: DecisionSource, counts: PoolCounts | null): string {
  if (v === "hybrid") {
    const chat = counts?.chat;
    const so = counts?.systemone;
    if (!chat || chat.available === 0) return "混合决策需要一个可用的对话模型（分析端），请先到「模型管理」页配置";
    if (!so || so.available === 0) return "混合决策需要一个可用的 System One 决策模型（决策端），请先到「模型管理」页配置";
    return "";
  }
  if (v === "rules") return "";
  return `请先到「模型管理」页添加并配置${v === "chat" ? "对话模型" : "决策模型"}`;
}