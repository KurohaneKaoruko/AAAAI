/** 策略页：策略选择与参数、Agent 流水线说明。 */

import { useEffect, useState } from "react";
import type { AppStore } from "../state/useAppStore";
import { Button, Notice, NumberField, Panel, SelectField } from "../components/ui";
import { DecisionSourceSwitch } from "../components/DecisionSourceSwitch";
import { api } from "../api";
import type { PoolCounts } from "../types";
import { pct } from "../lib/format";

const AGENTS = [
  { name: "MarketAnalyst", zh: "市场分析", in: "K 线流", out: "市场解读（趋势/动量）" },
  { name: "Strategist", zh: "策略决策", in: "市场解读 + 历史 K 线", out: "目标仓位信号" },
  { name: "RiskGuard", zh: "风控审查", in: "目标仓位", out: "下单意图 / 拦截" },
  { name: "Broker", zh: "执行", in: "下单意图", out: "成交回报" },
  { name: "Portfolio", zh: "组合记账", in: "成交回报", out: "权益曲线 / 指标" },
];

export function StrategyPage({ store }: { store: AppStore }) {
  const config = store.state?.config;
  const [form, setForm] = useState(config?.strategy);
  const [saving, setSaving] = useState(false);
  const [pools, setPools] = useState<PoolCounts | null>(null);

  // 决策来源的实例数需要单独拉取
  const loadPools = async () => {
    try {
      const d = await api.llmProfiles();
      setPools(d.pools);
    } catch {
      /* 服务不可用时忽略 */
    }
  };
  useEffect(() => {
    void loadPools();
  }, [config?.strategy.decisionSource]);

  useEffect(() => {
    if (config?.strategy) setForm(config.strategy);
  }, [config?.strategy]);

  if (!form) return <div className="loading">加载中…</div>;
  const running = store.state?.status === "running";

  const save = async () => {
    setSaving(true);
    await store.patchConfig({ strategy: form });
    setSaving(false);
  };

  const llmOn = config?.llm?.enabled;

  const setSource = (v: "rules" | "chat" | "systemone") => {
    if (!config) return;
    void store.patchConfig({
      strategy: { ...config.strategy, decisionSource: v },
      // 保持 llm.enabled 与决策来源一致（仅用于兼容旧字段）
      llm: { ...config.llm, enabled: v !== "rules" },
    });
    void loadPools();
  };

  return (
    <div className="page page-strategy">
      <Panel title="智能体决策">
        <DecisionSourceSwitch
          value={config?.strategy.decisionSource ?? "rules"}
          counts={pools}
          busy={store.state?.status === "running"}
          onChange={setSource}
        />
        <div className="hint-line">
          当前：{config?.strategy.decisionSource === "rules"
            ? "纯规则（双均线动量），不调用模型"
            : config?.strategy.decisionSource === "chat"
              ? "由对话模型池决策，失败自动回退双均线动量"
              : "由 System One 决策模型池决策，失败自动回退双均线动量"}
          。模型配置在「模型管理」页；想比较谁更赚钱，去「模型对照」页跑对照实验。
        </div>
      </Panel>

      <Panel
        title="策略设置"
        subtitle="下次运行时生效"
        actions={
          <Button variant="primary" onClick={save} busy={saving} disabled={running}>
            保存
          </Button>
        }
      >
        <div className="grid-2">
          <NumberField
            label="目标仓位上限"
            hint="占总权益最大比例"
            value={form.maxTargetWeight}
            step={0.05}
            min={0.05}
            max={1}
            onChange={(v) => setForm({ ...form, maxTargetWeight: v })}
          />
          <NumberField
            label="快线窗口"
            hint="最近 N 根 K 线均值"
            value={form.fastWindow}
            min={2}
            max={100}
            onChange={(v) => setForm({ ...form, fastWindow: v })}
          />
          <NumberField
            label="慢线窗口"
            hint="须大于快线"
            value={form.slowWindow}
            min={3}
            max={400}
            onChange={(v) => setForm({ ...form, slowWindow: v })}
          />
        </div>

        {form.fastWindow >= form.slowWindow && (
          <Notice tone="error">快线窗口必须小于慢线窗口，否则策略无法计算。</Notice>
        )}

        <div className="explain-box">
          <strong>{form.name === "momentum" ? "动量策略" : "LLM 决策策略"}</strong>
          {form.name === "momentum" ? (
            <p>
              快线（{form.fastWindow}）高于慢线（{form.slowWindow}）时做多，差值越大仓位越高，
              最高 {pct(form.maxTargetWeight, 0)}。下跌时自动空仓。只做多，不加杠杆。
            </p>
          ) : (
            <p>
              每隔 {config?.llm.decisionInterval} 根 K 线把最近 20 根 K 线交给 LLM，
              让它输出 0~1 的目标仓位；LLM 不可用或输出异常时自动回退动量基线，流水线不中断。
              {llmOn ? "" : "（当前 LLM 未启用，将按纯动量运行）"}
            </p>
          )}
        </div>
      </Panel>

      <Panel title="Agent 流水线" subtitle="所有 Agent 通过事件总线解耦通信">
        <div className="pipeline">
          {AGENTS.map((a, i) => (
            <div className="pipeline-step" key={a.name}>
              <div className="pipeline-node">
                <div className="pipeline-name">{a.zh}</div>
                <div className="mono small dim">{a.name}</div>
              </div>
              <div className="pipeline-io">
                <span className="io in">入: {a.in}</span>
                <span className="io out">出: {a.out}</span>
              </div>
              {i < AGENTS.length - 1 && <span className="pipeline-arrow">→</span>}
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="执行模式" subtitle="下单方式，保存后下次运行生效">
        <SelectField
          label="执行"
          value={config?.execution?.mode ?? "paper"}
          onChange={(v) => void store.patchConfig({ execution: { ...config!.execution, mode: v as "paper" | "live" } })}
          options={[
            { value: "paper", label: "模拟成交（本地撮合，不动真钱）" },
            { value: "live", label: "真实下单（需交易所 API Key，危险）" },
          ]}
        />
        {config?.execution?.mode === "live" && (
          <Notice tone="warn">
            真实下单会通过交易所 API 发送真实订单。若所选连接不支持交易或未配置 Key，系统会自动降级为模拟成交。
          </Notice>
        )}
      </Panel>
    </div>
  );
}