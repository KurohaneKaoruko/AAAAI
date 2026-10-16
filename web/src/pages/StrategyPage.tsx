/**
 * 策略页。
 *
 * 之前这里是十几个面板顺排下来（策略、候选池、新闻、验证、进化、工具、执行模式……），
 * 一屏塞不下、也分不清哪些属于"策略"、哪些其实是全局开关。
 * 现在按用户要回答的问题分成四组标签：
 *
 *   策略   —— 这条策略怎么决策、配多少仓位（列表 + 编辑器，两栏）
 *   候选池 —— 交易哪些标的
 *   情报   —— 新闻与大模型工具
 *   验证   —— 前推验证与自我进化
 *
 * 执行模式（模拟/实盘）属于交易安全开关，已移到「风控」页。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppStore } from "../state/useAppStore";
import { Button, Notice, NumberField, Panel, Toggle } from "../components/ui";
import { DecisionSourceSwitch } from "../components/DecisionSourceSwitch";
import { CandidatePool } from "../components/CandidatePool";
import { NewsPanel } from "../components/NewsPanel";
import { EvolutionPanel } from "../components/EvolutionPanel";
import { OptimizePanel } from "../components/OptimizePanel";
import { ValidationPanel } from "../components/ValidationPanel";
import { StrategyList, describe } from "../components/StrategyProfiles";
import { api } from "../api";
import type { DecisionSource, PoolCounts, StrategyProfile } from "../types";
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
  switch (form.decisionSource) {
    case "rules":
      return "量化交易：本地算指标与仓位，完全不调用模型。快慢线交叉定方向，因子打分定强弱。";
    case "chat":
      return "对话模型：把最近 20 根 K 线交给大模型，由它给 0~1 的目标仓位；失败自动回退量化基线。";
    case "systemone":
      return "决策模型：System One 逐标的定档位，只做多；失败自动回退量化基线。";
    case "hybrid":
      return `混合决策：大模型只做行情分析（影响力 ${Math.round((form.hybridInfluence ?? 0.6) * 100)}%），决策模型拿分析定仓位。`;
  }
}

function visibleAgents(selfAllocating: boolean): AgentNode[] {
  return AGENTS.filter((a) => !a.mode || (selfAllocating ? a.mode === "allocating" : a.mode === "perSymbol"));
}

export type StrategyTab = "strategy" | "pool" | "intel" | "validate";

export function StrategyPage({ store, initialTab }: { store: AppStore; initialTab?: StrategyTab }) {
  const config = store.state?.config;
  const running = false; // 机器人各自独立运行，策略配置随时可改（下次该机器人启动时生效）
  const [tab, setTab] = useState<StrategyTab>(initialTab ?? "strategy");

  const [strategies, setStrategies] = useState<StrategyProfile[]>([]);
  const [defaultId, setDefaultId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState<StrategyForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [pools, setPools] = useState<PoolCounts | null>(null);

  /** 切到另一条策略；有未保存修改时先确认，避免默默丢掉用户刚调的东西。 */
  const selectStrategy = (id: string) => {
    if (id === selectedId) return;
    if (dirtyFields.length > 0 && !confirm("当前策略有未保存的修改，切换后会被丢弃。继续？")) return;
    setSelectedId(id);
  };

  const loadStrategies = useCallback(async () => {
    try {
      const d = await api.strategies();
      setStrategies(d.strategies);
      setDefaultId(d.defaultId);
      setSelectedId((cur) => (d.strategies.some((s) => s.id === cur) ? cur : d.defaultId));
    } catch {
      /* 拉不到时下方提示 */
    }
  }, []);

  useEffect(() => {
    void loadStrategies();
  }, [loadStrategies]);

  const editing = strategies.find((s) => s.id === selectedId) ?? strategies[0] ?? null;

  // 切换选中策略时重置表单（未保存的修改会提示后再切换）
  useEffect(() => {
    if (editing) setForm(toForm(editing));
  }, [editing?.id]);

  useEffect(() => {
    api
      .llmProfiles()
      .then((d) => setPools(d.pools))
      .catch(() => undefined);
  }, [form?.decisionSource]);

  /**
   * 表单是否偏离已保存值：比较两份策略更新载荷即可。
   * 保存按钮据此置灰 —— 与其让用户空点一次（还要等一次网络往返才知道有没有生效），
   * 不如直接告诉他「有 N 处没保存」。
   */
  const dirtyFields = useMemo(() => {
    if (!editing || !form) return [] as string[];
    const saved = fromForm(toForm(editing));
    const draft = fromForm(form);
    return (Object.keys(saved) as (keyof StrategyProfile)[]).filter((k) => saved[k] !== draft[k]);
  }, [editing, form]);

  const save = async () => {
    if (!editing || !form) return;
    setSaving(true);
    try {
      await api.updateStrategy(editing.id, fromForm(form));
      await loadStrategies();
      if (editing.id === defaultId) await store.reloadState();
    } catch {
      /* 错误由列表组件统一提示 */
    }
    setSaving(false);
  };

  const poolCount = store.watchlist.length;

  if (!form || !editing) {
    return (
      <div className="page page-strategy">
        <div className="loading">加载中…</div>
      </div>
    );
  }

  return (
    <div className="page page-strategy">
      <div className="page-tabs">
        <button type="button" className={`page-tab ${tab === "strategy" ? "page-tab-on" : ""}`} onClick={() => setTab("strategy")}>
          策略
          <span className="page-tab-count">{strategies.length}</span>
        </button>
        <button type="button" className={`page-tab ${tab === "pool" ? "page-tab-on" : ""}`} onClick={() => setTab("pool")}>
          候选池
          <span className="page-tab-count">{poolCount}</span>
        </button>
        <button type="button" className={`page-tab ${tab === "intel" ? "page-tab-on" : ""}`} onClick={() => setTab("intel")}>
          情报
        </button>
        <button type="button" className={`page-tab ${tab === "validate" ? "page-tab-on" : ""}`} onClick={() => setTab("validate")}>
          验证与进化
        </button>
      </div>

      {tab === "strategy" && (
        <div className="grid-strategy">
          <div>
            <Panel title="策略列表" subtitle="点一条来编辑；机器人引用同一条即可复用">
              <StrategyList
                items={strategies}
                defaultId={defaultId}
                selectedId={editing.id}
                onSelect={selectStrategy}
                onChanged={loadStrategies}
                running={running}
              />
            </Panel>
          </div>

          <div>
            <Panel
              title={`编辑：${editing.name}`}
              subtitle={describe(editing)}
              actions={
                editing.id === defaultId ? <span className="chip chip-sm chip-accent">默认策略 · 单次运行用</span> : undefined
              }
            >
              <DecisionSourceSwitch
                value={form.decisionSource}
                influence={form.hybridInfluence ?? 0.6}
                counts={pools}
                busy={running}
                onChange={(next: { source: DecisionSource; influence: number }) =>
                  setForm({ ...form, decisionSource: next.source, hybridInfluence: next.influence })
                }
              />
              <div className="hint-line">{sourceHint(form)}</div>

              <div className="grid-3" style={{ marginTop: 14 }}>
                <NumberField
                  label="目标仓位上限"
                  hint={`占总权益最高 ${pct(form.maxTargetWeight, 0)}`}
                  value={form.maxTargetWeight}
                  step={0.05}
                  min={0.05}
                  max={1}
                  onChange={(v) => setForm({ ...form, maxTargetWeight: v })}
                />
                <NumberField
                  label="快线窗口"
                  hint="最近 N 根均值"
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

              <Toggle
                label="AI 自主选资产（关闭：按候选池逐个标的定仓位）"
                checked={form.selfAllocating}
                onChange={(v) => setForm({ ...form, selfAllocating: v })}
              />
              {form.selfAllocating && (
                <div className="grid-3">
                  <NumberField
                    label="最多持有"
                    hint="同时持仓数量上限"
                    value={form.maxPositions}
                    min={1}
                    max={10}
                    onChange={(v) => setForm({ ...form, maxPositions: v })}
                  />
                  <NumberField
                    label="组合总仓位"
                    hint={`${pct(form.maxGrossExposure, 0)}，其余留现金`}
                    value={form.maxGrossExposure}
                    step={0.05}
                    min={0.05}
                    max={1}
                    onChange={(v) => setForm({ ...form, maxGrossExposure: v })}
                  />
                  <NumberField
                    label="配置间隔"
                    hint="每 N 轮行情配一次"
                    value={form.allocationInterval}
                    min={1}
                    max={200}
                    onChange={(v) => setForm({ ...form, allocationInterval: v })}
                  />
                </div>
              )}

              <div className={`save-bar ${dirtyFields.length > 0 ? "save-bar-dirty" : ""}`}>
                <span className="save-bar-text">
                  {dirtyFields.length > 0 ? `有未保存的修改：${dirtyFields.length} 项` : "已保存，下次运行生效"}
                </span>
                <div className="btn-row" style={{ margin: 0 }}>
                  {dirtyFields.length > 0 && (
                    <Button
                      small
                      variant="ghost"
                      onClick={() => setForm(toForm(editing))}
                    >
                      放弃修改
                    </Button>
                  )}
                  <Button variant="primary" small busy={saving} disabled={dirtyFields.length === 0} onClick={() => void save()}>
                    保存策略
                  </Button>
                </div>
              </div>
            </Panel>

            <OptimizePanel store={store} />

            <details className="collapse" style={{ marginTop: 14 }}>
              <summary>工作原理：这条策略跑起来会经过哪些环节</summary>
              <div className="collapse-body">
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
                <div className="explain-box">
                  <strong>这套流程怎么保证不出事</strong>
                  <p>
                    每个环节都能独立降级：模型超时或输出非法 → 回退量化基线；拿不到 K 线明细 → 回退横截面动量基线；
                    HRP 没有可用结果 → 保持因子分给出的权重；没有任何标拿到正分 → 空仓（不硬凑权重）；
                    风控不通过 → 不下单（而不是"小仓位试试"）。
                  </p>
                  <p className="dim">
                    新闻属外部不可信输入，只作为参考写进 prompt，不会直接触发交易。
                  </p>
                </div>
              </div>
            </details>
          </div>
        </div>
      )}

      {tab === "pool" && (
        <div className="grid-2">
          <CandidatePool store={store} />
          <div>
            <Panel title="这些标的会怎么被使用" subtitle="候选池决定策略的可选范围">
              <div className="explain-box">
                <strong>候选池 ≠ 持仓</strong>
                <p>
                  候选池只是「允许交易的标的集合」。是否真的买入、买多少，由策略与风控决定：
                  开启 AI 自主配置时由模型在池子里挑；关闭时按池内每个标的逐个定仓位。
                </p>
                <p className="dim">
                  当前 {poolCount} 个标的 · 策略「{editing.name}」最多持有 {form.selfAllocating ? form.maxPositions : "不限（受风控仓位上限约束）"} 个
                </p>
                <p className="dim">
                  例外：模拟交易所的标的是它自带的，不走候选池 —— 那里的行情是编出来的，挑标的没有意义。
                </p>
              </div>
            </Panel>
          </div>
        </div>
      )}

      {tab === "intel" && (
        <>
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
                <details className="collapse">
                  <summary>模型能用哪些工具、边界在哪</summary>
                  <div className="collapse-body">
                    <div className="explain-box">
                      <strong>六个只读工具</strong>
                      <p>
                        决策前如果缺信息，它会自己调用工具去查：<b>search_news</b>（新闻与公告）、
                        <b>get_history</b>（历史走势、涨跌幅与回撤）、<b>get_quote</b>（最新价）、
                        <b>get_allocation</b>（当前资产配置）、<b>get_performance</b>（账户表现）、
                        <b>list_candidates</b>（候选池）。
                      </p>
                      <p className="dim">
                        工具全部只读，模型没有任何下单或改参数的能力；每次调用都会记进日志，可逐条核对。
                        支持原生 function calling 的端点走原生协议，不支持的端点自动改用文本协议，国产模型同样能用。
                      </p>
                    </div>
                  </div>
                </details>
              </>
            )}
          </Panel>
        </>
      )}

      {tab === "validate" && (
        <>
          <ValidationPanel store={store} />
          <EvolutionPanel store={store} />
        </>
      )}

      {tab !== "strategy" && (
        <div className="hint-line" style={{ marginTop: 12 }}>
          提示：策略本身的参数在「策略」标签里改，这里是辅助信息。
        </div>
      )}
    </div>
  );
}

/** 表单：只覆盖策略侧字段。 */
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
    name: s.name,
    decisionSource: s.decisionSource,
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