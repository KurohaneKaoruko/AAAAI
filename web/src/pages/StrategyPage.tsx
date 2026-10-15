/** 策略页：策略选择与参数、Agent 流水线说明。 */

import { useEffect, useState } from "react";
import type { AppStore } from "../state/useAppStore";
import { Button, Notice, NumberField, Panel, SelectField, Toggle } from "../components/ui";
import { DecisionSourceSwitch } from "../components/DecisionSourceSwitch";
import { CandidatePool } from "../components/CandidatePool";
import { NewsPanel } from "../components/NewsPanel";
import { EvolutionPanel } from "../components/EvolutionPanel";
import { OptimizePanel } from "../components/OptimizePanel";
import { ValidationPanel } from "../components/ValidationPanel";
import { api } from "../api";
import type { DecisionSource, PoolCounts, StrategyProfile } from "../types";
import { StrategyProfiles, describe } from "../components/StrategyProfiles";
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

/** 决策来源的一句话说明（按当前选择生成）。 */
function sourceHint(form: { decisionSource: DecisionSource; hybridInfluence?: number }): string {
  const tail = "模型配置在「模型管理」页；想比较谁更赚钱，去「模型对照」页跑对照实验。";
  switch (form.decisionSource) {
    case "rules":
      return "当前：量化交易。本地计算指标与仓位，不调用任何模型。" + tail;
    case "chat":
      return "当前：对话模型。大模型看行情后直接给目标仓位，失败自动回退双均线动量。" + tail;
    case "systemone":
      return "当前：决策模型。System One 逐标的定档位，失败自动回退双均线动量。" + tail;
    case "hybrid":
      return `当前：混合决策。大模型分析行情（影响力 ${Math.round((form.hybridInfluence ?? 0.6) * 100)}%），决策模型据此定仓位。` + tail;
  }
}

/** 按当前模式挑流水线节点：配置器与逐标的决策互斥。 */
function visibleAgents(selfAllocating: boolean): AgentNode[] {
  return AGENTS.filter((a) => !a.mode || (selfAllocating ? a.mode === "allocating" : a.mode === "perSymbol"));
}

export function StrategyPage({ store }: { store: AppStore }) {
  const config = store.state?.config;
  const [form, setForm] = useState<StrategyForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [pools, setPools] = useState<PoolCounts | null>(null);
  // 策略列表与正在编辑的那条
  const [strategies, setStrategies] = useState<StrategyProfile[]>([]);
  const [defaultId, setDefaultId] = useState<string>("");
  const [editingId, setEditingId] = useState<string>("");

  const loadStrategies = async () => {
    try {
      const d = await api.strategies();
      setStrategies(d.strategies);
      setDefaultId(d.defaultId);
      setEditingId((cur) => (d.strategies.some((s) => s.id === cur) ? cur : d.defaultId));
    } catch {
      /* 列表拉不到时退回单策略编辑 */
    }
  };
  useEffect(() => {
    void loadStrategies();
  }, []);

  /** 正在编辑的策略（缺省 = 默认策略，也就是单次运行用的那条）。 */
  const editing = strategies.find((s) => s.id === editingId) ?? strategies.find((s) => s.id === defaultId) ?? null;
  const editingDefault = editing !== null && editing.id === defaultId;

  /** 改当前策略：先更新列表里的实体，默认策略再同步到 config.strategy（单次运行读它）。 */
  const patchStrategy = (patch: Partial<StrategyProfile>) => {
    if (!editing) return;
    void api
      .updateStrategy(editing.id, patch)
      .then(() => loadStrategies())
      .then(() => {
        if (editingDefault) void store.reloadState();
      })
      .catch(() => undefined);
  };

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
  }, [editing?.decisionSource]);

  // 编辑哪条策略，表单就跟着切成哪条
  useEffect(() => {
    if (editing) setForm(toForm(editing));
  }, [editing?.id]);

  if (!form) return <div className="loading">加载中…</div>;
  const running = store.state?.status === "running";

  /** 保存当前策略：改的是策略实体（全体引用它的机器人跟着变）。 */
  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await api.updateStrategy(editing.id, fromForm(form));
      await loadStrategies();
      if (editingDefault) await store.reloadState();
    } catch {
      /* 由列表刷新兜底 */
    }
    setSaving(false);
  };

  // 是否真的会用模型：唯一取决于决策来源（rules = 量化交易，不请求任何模型）
  const llmOn = (form.decisionSource ?? "rules") !== "rules";

  /** 决策方式变更：立即保存到当前策略。 */
  const setSource = (next: { source: DecisionSource; influence: number }) => {
    setForm((f) => (f ? { ...f, decisionSource: next.source, hybridInfluence: next.influence } : f));
    patchStrategy({ decisionSource: next.source, hybridInfluence: next.influence });
    void loadPools();
  };

  return (
    <div className="page page-strategy">
      <Panel title="策略列表" subtitle="策略是独立实体，机器人引用同一条即可复用">
        {strategies.length > 0 && (
          <div className="grid-2" style={{ marginBottom: 10 }}>
            <SelectField
              label="正在编辑"
              value={editing?.id ?? ""}
              options={strategies.map((s) => ({ value: s.id, label: describe(s) }))}
              onChange={setEditingId}
            />
          </div>
        )}
        <StrategyProfiles store={store} />
      </Panel>

      <Panel title="智能体决策">
        <DecisionSourceSwitch
          value={form.decisionSource}
          influence={form.hybridInfluence ?? 0.6}
          counts={pools}
          busy={store.state?.status === "running"}
          onChange={setSource}
        />
        <div className="hint-line">{sourceHint(form)}</div>
      </Panel>

      <OptimizePanel store={store} />

      <ValidationPanel store={store} />

      <CandidatePool store={store} />

      <NewsPanel store={store} />

      <Panel title="大模型工具能力" subtitle="让模型自己查信息再决策">
        <Toggle
          label="允许大模型调用只读工具（查新闻、看历史走势、看当前配置与持仓、列候选池）"
          checked={config?.llm.agentEnabled ?? true}
          onChange={(v) => void store.patchConfig({ llm: { ...config!.llm, agentEnabled: v } })}
        />
        {config?.llm.agentEnabled && (
          <>
            <div className="grid-2">
              <NumberField
                label="单次决策工具轮数"
                hint="每轮一次调用，0 = 不给工具"
                value={config?.llm.agentMaxSteps ?? 4}
                min={0}
                max={10}
                onChange={(v) => void store.patchConfig({ llm: { ...config!.llm, agentMaxSteps: v } })}
              />
            </div>
            <div className="explain-box">
              <strong>模型能做什么</strong>
              <p>
                决策前如果缺信息，它会自己调用工具去查：<b>search_news</b>（新闻与公告）、
                <b>get_history</b>（历史走势、涨跌幅与回撤）、<b>get_quote</b>（最新价）、
                <b>get_allocation</b>（当前资产配置）、<b>get_performance</b>（账户表现）、
                <b>list_candidates</b>（候选池）。
                工具全部只读，模型没有任何下单能力；每次调用都会记进日志，方便你核对它到底查了什么。
              </p>
              <p className="dim">
                支持原生 function calling 的端点走原生协议；不支持的端点自动改用文本协议（模型输出一行工具调用 JSON），
                因此国产模型等不支持 tools 的端点同样能用。
              </p>
            </div>
          </>
        )}
      </Panel>

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
                  ? "量化交易（按横截面动量选资产，不调用模型）"
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
              {llmOn ? "" : "（当前为量化交易模式，不会请求任何模型）"}
            </p>
          )}
        </div>
      </Panel>

      <EvolutionPanel store={store} />

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
/** 表单：只覆盖策略侧字段（其它策略参数在列表里建/复制时带上）。 */
interface StrategyForm {
  name: string;
  decisionSource: DecisionSource;
  fastWindow: number;
  slowWindow: number;
  maxTargetWeight: number;
  selfAllocating: boolean;
  maxPositions: number;
  maxGrossExposure: number;
  allocationInterval: number;
  hybridInfluence: number;
  hybridAnalysisTtlMs: number;
}

/** 策略实体 -> 表单。 */
function toForm(s: StrategyProfile): StrategyForm {
  return {
    decisionSource: s.decisionSource,
    name: s.name,
    fastWindow: s.fastWindow,
    slowWindow: s.slowWindow,
    maxTargetWeight: s.maxTargetWeight,
    selfAllocating: s.selfAllocating,
    maxPositions: s.maxPositions,
    maxGrossExposure: s.maxGrossExposure,
    allocationInterval: s.allocationInterval,
    hybridInfluence: s.hybridInfluence,
    hybridAnalysisTtlMs: s.hybridAnalysisTtlMs,
  };
}

/** 表单 -> 策略更新（只回写策略侧字段）。 */
function fromForm(form: StrategyForm): Partial<StrategyProfile> {
  return {
    name: form.name,
    decisionSource: form.decisionSource,
    fastWindow: form.fastWindow,
    slowWindow: form.slowWindow,
    maxTargetWeight: form.maxTargetWeight,
    selfAllocating: form.selfAllocating,
    maxPositions: form.maxPositions,
    maxGrossExposure: form.maxGrossExposure,
    allocationInterval: form.allocationInterval,
    hybridInfluence: form.hybridInfluence,
    hybridAnalysisTtlMs: form.hybridAnalysisTtlMs,
  };
}
