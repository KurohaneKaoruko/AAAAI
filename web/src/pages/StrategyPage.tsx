/** 策略页：策略选择与参数、Agent 流水线说明。 */

import { useEffect, useState } from "react";
import type { AppStore } from "../state/useAppStore";
import { Button, Notice, NumberField, Panel, SelectField, Toggle } from "../components/ui";
import { DecisionSourceSwitch, ratioPct, SOURCE_ZH } from "../components/DecisionSourceSwitch";
import { CandidatePool } from "../components/CandidatePool";
import { api } from "../api";
import type { DecisionSource, PoolCounts } from "../types";
import { pct } from "../lib/format";

interface AgentNode {
  name: string;
  zh: string;
  in: string;
  out: string;
  /** 二选一：Allocator 与 Strategist 同一时刻只启用一个 */
  mode?: "allocating" | "perSymbol";
}

const AGENTS: AgentNode[] = [
  { name: "MarketAnalyst", zh: "市场分析", in: "K 线流", out: "市场解读（趋势/动量）" },
  { name: "Allocator", zh: "资产配置", in: "K 线流 + 候选池", out: "资产配置 → 逐标的目标仓位", mode: "allocating" },
  { name: "Strategist", zh: "策略决策", in: "市场解读 + 历史 K 线", out: "目标仓位信号", mode: "perSymbol" },
  { name: "RiskGuard", zh: "风控审查", in: "目标仓位", out: "下单意图 / 拦截" },
  { name: "Broker", zh: "执行", in: "下单意图", out: "成交回报" },
  { name: "Portfolio", zh: "组合记账", in: "成交回报", out: "权益曲线 / 指标" },
];

/** 决策来源的一句话说明（按参与的路与配比生成）。 */
function sourceHint(form: {
  sources?: DecisionSource[];
  blend?: Record<DecisionSource, number>;
}): string {
  const sources: DecisionSource[] = form.sources?.length ? form.sources : ["rules"];
  const parts = ratioPct(sources, form.blend ?? { rules: 1, chat: 0, systemone: 0 })
    .map((r) => `${SOURCE_ZH[r.source]} ${r.pct}%`);
  const tail =
    sources.length > 1
      ? "多路按配比线性融合；任一路无实例或调用失败会当场退出，配比自动让给其余路，组合不会停摆。"
      : sources[0] === "rules"
        ? "纯规则本地计算，不调用任何模型。"
        : "由模型池决策，失败自动回退双均线动量。";
  return `当前：${parts.join(" + ")}。${tail}模型配置在「模型管理」页；想比较谁更赚钱，去「模型对照」页跑对照实验。`;
}

/** 按当前模式挑流水线节点：配置器与逐标的决策互斥。 */
function visibleAgents(selfAllocating: boolean): AgentNode[] {
  return AGENTS.filter((a) => !a.mode || (selfAllocating ? a.mode === "allocating" : a.mode === "perSymbol"));
}

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

  /** 多路/配比变更：立即落库，并保持 decisionSource 与 llm.enabled 与之一致。 */
  const setSources = (next: { sources: DecisionSource[]; blend: Record<DecisionSource, number> }) => {
    if (!config) return;
    const sources = next.sources.length > 0 ? next.sources : (["rules"] as DecisionSource[]);
    void store.patchConfig({
      strategy: { ...config.strategy, sources, blend: next.blend, decisionSource: sources[0]! },
      llm: { ...config.llm, enabled: sources.some((s) => s !== "rules") },
    });
    void loadPools();
  };

  return (
    <div className="page page-strategy">
      <Panel title="智能体决策">
        <DecisionSourceSwitch
          sources={form.sources ?? [form.decisionSource]}
          blend={form.blend ?? { rules: 1, chat: 0, systemone: 0 }}
          counts={pools}
          busy={store.state?.status === "running"}
          onChange={setSources}
        />
        <div className="hint-line">{sourceHint(form)}</div>
      </Panel>

      <CandidatePool store={store} />

      <Panel
        title="AI 自主配置资产"
        subtitle="让模型自己在候选池里选标的、配权重"
      >
        <Toggle
          label="启用资产配置器（关闭时：人指定标的，模型只决定每个标的的仓位）"
          checked={form.selfAllocating ?? false}
          onChange={(v) => setForm({ ...form, selfAllocating: v })}
        />
        {form.selfAllocating && (
          <>
            <div className="grid-3">
              <NumberField
                label="最多持有资产数"
                hint="选中的标的数量上限"
                value={form.maxPositions}
                min={1}
                max={10}
                onChange={(v) => setForm({ ...form, maxPositions: v })}
              />
              <NumberField
                label="组合总仓位上限"
                hint={`当前 ${pct(form.maxGrossExposure, 0)}，其余留现金`}
                value={form.maxGrossExposure}
                step={0.05}
                min={0.05}
                max={1}
                onChange={(v) => setForm({ ...form, maxGrossExposure: v })}
              />
              <NumberField
                label="配置间隔"
                hint="每 N 轮行情决策一次"
                value={form.allocationInterval}
                min={1}
                max={200}
                onChange={(v) => setForm({ ...form, allocationInterval: v })}
              />
            </div>
            <div className="explain-box">
              <strong>它是怎么工作的</strong>
              <p>
                每 {form.allocationInterval} 轮行情，把候选池里每个标的的价格、涨跌、均线动量、趋势
                汇总成一张表交给模型，模型回答「买哪些、各占多少、留多少现金」。
                系统会裁掉候选池外的标的、压住单标的与总仓位上限，被放弃的标的自动清仓；
                模型不可用、超时或输出不合法时自动回退到横截面动量基线。
                单标的上限仍受「风控」页的仓位上限约束。
              </p>
              <p className="dim">
                当前决策来源：
                {config?.strategy.decisionSource === "rules"
                  ? "纯规则（按横截面动量选资产，不调用模型）"
                  : config?.strategy.decisionSource === "chat"
                    ? "对话模型（OpenAI 兼容）"
                    : "System One 决策模型（每标的各问一道档位题）"}
              </p>
            </div>
          </>
        )}
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
          {visibleAgents(form.selfAllocating).map((a, i, list) => (
            <div className="pipeline-step" key={a.name}>
              <div className="pipeline-node">
                <div className="pipeline-name">{a.zh}</div>
                <div className="mono small dim">{a.name}</div>
              </div>
              <div className="pipeline-io">
                <span className="io in">入: {a.in}</span>
                <span className="io out">出: {a.out}</span>
              </div>
              {i < list.length - 1 && <span className="pipeline-arrow">→</span>}
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