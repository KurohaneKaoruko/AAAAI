/** 风控页：资金、交易成本、仓位与熔断。 */

import { useEffect, useState } from "react";
import type { AppStore } from "../state/useAppStore";
import type { RiskSection } from "../types";
import { Button, Notice, NumberField, Panel } from "../components/ui";
import { money, pct } from "../lib/format";

export function RiskPage({ store }: { store: AppStore }) {
  const config = store.state?.config;
  const [form, setForm] = useState<RiskSection | undefined>(config?.risk);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (config?.risk) setForm(config.risk);
  }, [config?.risk]);

  if (!form) return <div className="loading">加载中…</div>;

  const save = async () => {
    setSaving(true);
    await store.patchConfig({ risk: form });
    setSaving(false);
  };

  const set = <K extends keyof RiskSection>(k: K, v: RiskSection[K]) =>
    setForm({ ...form, [k]: v });

  return (
    <div className="page page-risk">
      <Panel
        title="资金与成本"
        actions={
          <Button variant="primary" onClick={save} busy={saving} disabled={store.state?.status === "running"}>
            保存
          </Button>
        }
      >
        <div className="grid-2">
          <NumberField label="初始资金" value={form.initialCash} step={1000} min={100} onChange={(v) => set("initialCash", v)} />
          <NumberField
            label="手续费率"
            hint={`单边 ${(form.feeRate * 100).toFixed(3)}%`}
            value={form.feeRate}
            step={0.0001}
            min={0}
            max={0.01}
            onChange={(v) => set("feeRate", v)}
          />
          <NumberField
            label="模拟滑点"
            hint={`${form.slippageBps} bps`}
            value={form.slippageBps}
            step={1}
            min={0}
            max={200}
            onChange={(v) => set("slippageBps", v)}
          />
          <NumberField
            label="单笔金额上限"
            value={form.maxOrderValue}
            step={1000}
            min={100}
            onChange={(v) => set("maxOrderValue", v)}
          />
        </div>
      </Panel>

      <Panel title="仓位与熔断">
        <div className="grid-2">
          <NumberField
            label="单标的仓位上限"
            hint={pct(form.maxPositionWeight, 0)}
            value={form.maxPositionWeight}
            step={0.05}
            min={0.05}
            max={1}
            onChange={(v) => set("maxPositionWeight", v)}
          />
          <NumberField
            label="组合回撤熔断"
            hint={pct(form.maxDrawdownPct, 0)}
            value={form.maxDrawdownPct}
            step={0.01}
            min={0.01}
            max={1}
            onChange={(v) => set("maxDrawdownPct", v)}
          />
        </div>

        <div className="explain-box">
          <strong>风险闸门说明</strong>
          <ul className="notes">
            <li>
              信号目标仓位超过 <b>{pct(form.maxPositionWeight, 0)}</b> 时直接拦截，不会发出订单；
            </li>
            <li>
              单笔调仓金额被截断到 <b>{money(form.maxOrderValue, 0)}</b> 以内，避免一次性重仓；
            </li>
            <li>
              组合回撤达到 <b>{pct(form.maxDrawdownPct, 0)}</b> 触发熔断：实时模式自动停机，回测模式后续信号全部拒绝；
            </li>
            <li>风控在订单发出之前执行，是最后一道闸门，任何 Agent 都无法绕过。</li>
          </ul>
        </div>
        <Notice tone="info">
          改动立即保存，下次运行生效。运行中的引擎保持使用启动时的参数快照。
        </Notice>
      </Panel>
    </div>
  );
}