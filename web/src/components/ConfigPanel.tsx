import { useState } from "react";
import type { EngineConfig } from "../types";

interface FormState {
  initialCash: number;
  feeRate: number;
  slippageBps: number;
  maxOrderValue: number;
  maxPositionWeight: number;
  maxDrawdownPct: number;
  fastWindow: number;
  slowWindow: number;
  maxTargetWeight: number;
}

const DEFAULTS: FormState = {
  initialCash: 100000,
  feeRate: 0.0003,
  slippageBps: 2,
  maxOrderValue: 20000,
  maxPositionWeight: 0.6,
  maxDrawdownPct: 0.15,
  fastWindow: 5,
  slowWindow: 20,
  maxTargetWeight: 0.5,
};

export function ConfigPanel({
  config,
  disabled,
  onSave,
}: {
  config: EngineConfig | null;
  disabled: boolean;
  onSave: (patch: unknown) => void;
}) {
  const [form, setForm] = useState<FormState>(DEFAULTS);
  const [saved, setSaved] = useState(false);

  // 后端配置到达后同步表单（仅首次）
  const [synced, setSynced] = useState(false);
  if (config && !synced) {
    setForm({
      initialCash: config.risk.initialCash,
      feeRate: config.risk.feeRate,
      slippageBps: config.risk.slippageBps,
      maxOrderValue: config.risk.maxOrderValue,
      maxPositionWeight: config.risk.maxPositionWeight,
      maxDrawdownPct: config.risk.maxDrawdownPct,
      fastWindow: config.strategy.fastWindow,
      slowWindow: config.strategy.slowWindow,
      maxTargetWeight: config.strategy.maxTargetWeight,
    });
    setSynced(true);
  }

  const set = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value);
    setForm((f) => ({ ...f, [key]: Number.isFinite(value) ? value : f[key] }));
    setSaved(false);
  };

  const submit = () => {
    onSave({
      risk: {
        initial_cash: form.initialCash,
        fee_rate: form.feeRate,
        slippage_bps: form.slippageBps,
        max_order_value: form.maxOrderValue,
        max_position_weight: form.maxPositionWeight,
        max_drawdown_pct: form.maxDrawdownPct,
      },
      strategy: {
        fast_window: form.fastWindow,
        slow_window: form.slowWindow,
        max_target_weight: form.maxTargetWeight,
      },
    });
    setSaved(true);
  };

  return (
    <div className="panel">
      <div className="panel-title">
        参数配置
        <span className="panel-sub">保存后对下一次运行生效</span>
      </div>
      <div className="form">
        <label className="field">
          <span>初始资金</span>
          <input type="number" value={form.initialCash} onChange={set("initialCash")} />
        </label>
        <label className="field">
          <span>手续费率</span>
          <input type="number" step="0.0001" value={form.feeRate} onChange={set("feeRate")} />
        </label>
        <label className="field">
          <span>滑点 (bps)</span>
          <input type="number" value={form.slippageBps} onChange={set("slippageBps")} />
        </label>
        <label className="field">
          <span>单笔金额上限</span>
          <input type="number" value={form.maxOrderValue} onChange={set("maxOrderValue")} />
        </label>
        <label className="field">
          <span>仓位上限 (0~1)</span>
          <input type="number" step="0.05" value={form.maxPositionWeight} onChange={set("maxPositionWeight")} />
        </label>
        <label className="field">
          <span>回撤熔断 (0~1)</span>
          <input type="number" step="0.01" value={form.maxDrawdownPct} onChange={set("maxDrawdownPct")} />
        </label>
        <label className="field">
          <span>快线窗口</span>
          <input type="number" value={form.fastWindow} onChange={set("fastWindow")} />
        </label>
        <label className="field">
          <span>慢线窗口</span>
          <input type="number" value={form.slowWindow} onChange={set("slowWindow")} />
        </label>
        <label className="field">
          <span>目标仓上限 (0~1)</span>
          <input type="number" step="0.05" value={form.maxTargetWeight} onChange={set("maxTargetWeight")} />
        </label>
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={submit} disabled={disabled}>
            保存参数
          </button>
          {saved && <span className="form-ok">已保存</span>}
        </div>
      </div>
    </div>
  );
}
