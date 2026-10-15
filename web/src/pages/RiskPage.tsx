/** 风控页：资金、交易成本、仓位与熔断。 */

import { useEffect, useState } from "react";
import type { AppStore } from "../state/useAppStore";
import type { RiskSection } from "../types";
import { Button, Notice, NumberField, Panel, SelectField } from "../components/ui";
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

  const exec = config?.execution;
  const live = exec?.mode === "live";

  return (
    <div className="page page-risk">
      <Panel title="执行方式" subtitle="模拟成交还是真实下单 —— 动真金的地方放最前面">
        <SelectField
          label="执行"
          value={exec?.mode ?? "paper"}
          options={[
            { value: "paper", label: "模拟成交（本地撮合，不动真钱）" },
            { value: "live", label: "真实下单（需交易所 API Key，危险）" },
          ]}
          onChange={(v) =>
            void store.patchConfig({ execution: { ...exec!, mode: v as "paper" | "live" } })
          }
        />
        {live ? (
          <Notice tone="warn">
            当前为<strong>真实下单</strong>：订单会通过交易所 API 发出去。若所选连接不支持交易或未配置 Key，
            系统会自动降级为模拟成交。切回模拟请立刻修改此处。
          </Notice>
        ) : (
          <Notice tone="info">当前为模拟成交：所有订单在本地撮合，不涉及真实资金。</Notice>
        )}
        <div className="hint-line">已保存。正在运行的引擎继续使用启动时的设置，重新启动后生效。</div>
      </Panel>

      <Panel
        title="资金与成本"
        actions={
          <Button variant="primary" onClick={save} busy={saving}>
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
            label="最小调仓额"
            hint={form.minTradeValue > 0 ? `${form.minTradeValue} 起` : "不限制"}
            value={form.minTradeValue}
            step={500}
            min={0}
            onChange={(v) => set("minTradeValue", v)}
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
              单次调仓金额低于 <b>{form.minTradeValue > 0 ? form.minTradeValue : 0}</b> 时视为噪声调整，直接忽略
              （0 表示不限制；调小它会让成交更频繁，但也更容易被手续费吃掉）。
            </li>
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