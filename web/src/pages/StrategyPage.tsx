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
import { Button, Notice, NumberField, Panel, SelectField, Toggle } from "../components/ui";
import { DecisionSourceSwitch } from "../components/DecisionSourceSwitch";
import { CandidatePool } from "../components/CandidatePool";
import { NewsPanel } from "../components/NewsPanel";
import { EvolutionPanel } from "../components/EvolutionPanel";
import { OptimizePanel } from "../components/OptimizePanel";
import { ValidationPanel } from "../components/ValidationPanel";
import { StrategyList, describe } from "../components/StrategyProfiles";
import { api } from "../api";
import type { DecisionSource, PoolCounts, StrategyProfile, StrategyEngine } from "../types";
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
      return "量化交易：本地算指标与仓位，完全不调用模型。趋势强度按噪声归一，低于噪声不进场；下方可切换经典双均线或自适应趋势引擎。";
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

export function StrategyPage({
  store,
  initialTab,
  onTabChange,
}: {
  store: AppStore;
  initialTab?: StrategyTab;
  /** 标签切换同步给 App，写进 URL（刷新/前进后退能落回同一标签） */
  onTabChange?: (tab: StrategyTab) => void;
}) {
  const config = store.state?.config;
  const running = false; // 机器人各自独立运行，策略配置随时可改（下次该机器人启动时生效）
  const [tab, setTab] = useState<StrategyTab>(initialTab ?? "strategy");

  // App 的哈希路由变化（浏览器前进/后退、页内跳转）时同步当前标签
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  const changeTab = (next: StrategyTab) => {
    setTab(next);
    onTabChange?.(next);
  };

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
        <button type="button" className={`page-tab ${tab === "strategy" ? "page-tab-on" : ""}`} onClick={() => changeTab("strategy")}>
          策略
          <span className="page-tab-count">{strategies.length}</span>
        </button>
        <button type="button" className={`page-tab ${tab === "pool" ? "page-tab-on" : ""}`} onClick={() => changeTab("pool")}>
          候选池
          <span className="page-tab-count">{poolCount}</span>
        </button>
        <button type="button" className={`page-tab ${tab === "intel" ? "page-tab-on" : ""}`} onClick={() => changeTab("intel")}>
          情报
        </button>
        <button type="button" className={`page-tab ${tab === "validate" ? "page-tab-on" : ""}`} onClick={() => changeTab("validate")}>
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

              <SelectField
                label={form.decisionSource === "rules" ? "量化引擎" : "规则回退引擎"}
                hint={
                  form.selfAllocating
                    ? "当前开启 AI/规则自主选资产：由因子配置器决定权重，此引擎仅在逐标的模式生效"
                    : form.engine === "adaptive"
                      ? "自适应趋势：效率比/突破/ATR 止损/波动率缩放"
                      : form.engine === "breakout"
                        ? "唐奇安突破：慢线=入场通道，快线=离场通道，ATR 止损"
                        : form.engine === "meanrev"
                          ? "布林均值回归：慢线=均值窗口，快线=趋势过滤；适合震荡市"
                          : form.engine === "custom"
                            ? "自定义策略：自己写代码决定仓位，在沙箱里运行"
                            : "经典双均线：噪声归一 t 统计量"
                }
                value={form.engine}
                options={[
                  { value: "momentum", label: "经典双均线" },
                  { value: "adaptive", label: "自适应趋势（稳健备选）" },
                  { value: "breakout", label: "唐奇安突破（趋势）" },
                  { value: "meanrev", label: "布林均值回归（震荡）" },
                  { value: "custom", label: "自定义代码（写你自己的策略）" },
                ]}
                onChange={(v) => setForm({ ...form, engine: v as StrategyEngine })}
              />

              {form.engine === "custom" && <CustomCodePanel form={form} setForm={setForm} />}

              <div className="grid-3" style={{ marginTop: form.engine === "custom" ? 14 : undefined }}>
                <NumberField
                  label="目标仓位上限"
                  hint={form.engine === "custom" ? "信号超过此值会被钳到这（自定义策略也受风控约束）" : `占总权益最高 ${pct(form.maxTargetWeight, 0)}`}
                  value={form.maxTargetWeight}
                  step={0.05}
                  min={0.05}
                  max={1}
                  onChange={(v) => setForm({ ...form, maxTargetWeight: v })}
                />
                {form.engine !== "custom" && (
                  <>
                    <NumberField
                      label={
                        form.engine === "breakout"
                          ? "离场通道"
                          : form.engine === "meanrev"
                            ? "趋势过滤窗口"
                            : "快线窗口"
                      }
                      hint={
                        form.engine === "breakout"
                          ? "跌破/突破 N 根反向通道离场"
                          : form.engine === "meanrev"
                            ? "短均线，过滤接飞刀"
                            : "最近 N 根均值"
                      }
                      value={form.fastWindow}
                      min={2}
                      max={100}
                      onChange={(v) => setForm({ ...form, fastWindow: v })}
                    />
                    <NumberField
                      label={
                        form.engine === "breakout"
                          ? "入场通道"
                          : form.engine === "meanrev"
                            ? "均值窗口"
                            : "慢线窗口"
                      }
                      hint={
                        form.engine === "breakout"
                          ? "突破 N 根最高/最低入场"
                          : form.engine === "meanrev"
                            ? "布林带均值/标准差窗口"
                            : "须大于快线"
                      }
                      value={form.slowWindow}
                      min={3}
                      max={400}
                      onChange={(v) => setForm({ ...form, slowWindow: v })}
                    />
                  </>
                )}
              </div>

              {form.engine !== "custom" && form.fastWindow >= form.slowWindow && (
                <Notice tone="error">快线窗口必须小于慢线窗口，否则策略无法计算。</Notice>
              )}

              <Toggle
                label="允许做空（仅合约连接生效）"
                hint="现货连接会忽略；合约连接遇到向下强趋势时输出负仓位"
                checked={form.allowShort}
                onChange={(v) => setForm({ ...form, allowShort: v })}
              />

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
                  例外：模拟交易所没有标的（只有几条走向），不进候选池 —— 那几条走向是本地生成的，挑标的没有意义。
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
  engine: StrategyEngine;
  fastWindow: number;
  slowWindow: number;
  maxTargetWeight: number;
  allowShort: boolean;
  selfAllocating: boolean;
  maxPositions: number;
  maxGrossExposure: number;
  allocationInterval: number;
  hybridInfluence: number;
  hybridAnalysisTtlMs: number;
  strategyCode: string;
}

/** 策略实体 -> 表单。 */
function toForm(s: StrategyProfile): StrategyForm {
  return {
    name: s.name,
    decisionSource: s.decisionSource,
    engine: s.engine,
    fastWindow: s.fastWindow,
    slowWindow: s.slowWindow,
    maxTargetWeight: s.maxTargetWeight,
    allowShort: s.allowShort,
    selfAllocating: s.selfAllocating,
    maxPositions: s.maxPositions,
    maxGrossExposure: s.maxGrossExposure,
    allocationInterval: s.allocationInterval,
    hybridInfluence: s.hybridInfluence,
    hybridAnalysisTtlMs: s.hybridAnalysisTtlMs,
    strategyCode: s.strategyCode,
  };
}

/** 表单 -> 策略更新（只回写策略侧字段）。 */
function fromForm(form: StrategyForm): Partial<StrategyProfile> {
  return {
    name: form.name,
    decisionSource: form.decisionSource,
    engine: form.engine,
    fastWindow: form.fastWindow,
    slowWindow: form.slowWindow,
    maxTargetWeight: form.maxTargetWeight,
    allowShort: form.allowShort,
    selfAllocating: form.selfAllocating,
    maxPositions: form.maxPositions,
    maxGrossExposure: form.maxGrossExposure,
    allocationInterval: form.allocationInterval,
    hybridInfluence: form.hybridInfluence,
    hybridAnalysisTtlMs: form.hybridAnalysisTtlMs,
    strategyCode: form.strategyCode,
  };
}

/** 自定义策略示例：双均线金叉，最常见的第一份代码。 */
const CUSTOM_EXAMPLE = `// 例：5/20 双均线金叉做多，死叉平仓
const fast = helpers.sma(bars, 5);
const slow = helpers.sma(bars, 20);
if (fast.length < 1) return 0;
const golden = helpers.crossover(fast, slow);
const dead = helpers.crossunder(fast, slow);
if (golden) return 0.5;
if (dead) return 0;
// 持仓期间保持
return state.holding ? 0.5 : 0;`;

/** 自定义策略代码编辑面板：写代码 → 校验 → 真实行情试跑。 */
function CustomCodePanel({
  form,
  setForm,
}: {
  form: StrategyForm;
  setForm: (f: StrategyForm) => void;
}) {
  const [check, setCheck] = useState<{ ok: boolean; error?: string; warmup?: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [tryResult, setTryResult] = useState<Awaited<ReturnType<typeof api.tryStrategyCode>> | null>(null);
  const [trying, setTrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doCheck = async () => {
    setChecking(true);
    setError(null);
    try {
      const r = await api.checkStrategyCode(form.strategyCode);
      setCheck(r);
    } catch (e) {
      setError((e as Error).message);
    }
    setChecking(false);
  };

  const doTry = async () => {
    setTrying(true);
    setError(null);
    try {
      const r = await api.tryStrategyCode({ code: form.strategyCode, barCount: 200 });
      setTryResult(r);
    } catch (e) {
      setError((e as Error).message);
    }
    setTrying(false);
  };

  return (
    <div className="custom-code-panel" style={{ marginTop: 14 }}>
      <div className="hint-line" style={{ marginBottom: 8 }}>
        函数体，参数由平台注入：bars（K 线数组，旧→新：timestamp/open/high/low/close/volume）、
        state（跨 K 线持久对象，每标的独立）、asset（当前标的）、helpers（指标助手）。
        返回 0~1 的目标仓位（0=空仓，null=不动）；log() 可打日志。
        <strong> 沙箱运行：没有网络/文件/进程访问，每根 K 线 50ms 超时。</strong>
      </div>
      <textarea
        className="code-editor"
        spellCheck={false}
        value={form.strategyCode}
        onChange={(e) => {
          setForm({ ...form, strategyCode: e.target.value });
          setCheck(null);
          setTryResult(null);
        }}
        rows={14}
        placeholder={CUSTOM_EXAMPLE}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Button small onClick={doCheck} busy={checking}>
          校验代码
        </Button>
        <Button small onClick={doTry} busy={trying}>
          真实行情试跑
        </Button>
        {form.strategyCode.trim() === "" && (
          <Button
            small
            onClick={() => {
              setForm({ ...form, strategyCode: CUSTOM_EXAMPLE });
              setCheck(null);
              setTryResult(null);
            }}
          >
            填入示例
          </Button>
        )}
        {check && (
          <span className={check.ok ? "chip chip-sm chip-ok" : "chip chip-sm chip-danger"}>
            {check.ok ? `✓ 编译通过 · 预热约 ${check.warmup} 根 K 线` : `✗ ${check.error}`}
          </span>
        )}
      </div>
      {error && (
        <div style={{ marginTop: 8 }}>
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {tryResult && (
        <div style={{ marginTop: 10 }}>
          {tryResult.results.map((r) => {
            const ws = r.weights.filter((x) => typeof x.w === "number") as { t: string; w: number }[];
            const signals = ws.length;
            const active = ws.filter((x) => x.w > 0).length;
            const lastW = ws.length > 0 ? ws[ws.length - 1]!.w : 0;
            return (
              <div key={r.symbol} style={{ marginBottom: 6 }}>
                <div className="hint-line">
                  {r.symbol}：最近 {r.count} 根里给出信号 {signals} 次、有仓位 {active} 次，
                  当前目标 {pct(lastW, 1)}
                  {r.error ? ` · ⚠ ${r.error}` : ""}
                </div>
                {ws.length > 0 && (
                  <svg viewBox="0 0 600 60" style={{ width: "100%", height: 60 }} className="try-spark">
                    {(() => {
                      const n = ws.length;
                      const pts = ws
                        .map((x, i) => `${(i / Math.max(1, n - 1)) * 600},${55 - x.w * 50}`)
                        .join(" ");
                      return (
                        <>
                          <line x1="0" y1="55" x2="600" y2="55" stroke="var(--border, #ccc)" strokeWidth="0.5" />
                          <polyline points={pts} fill="none" stroke="var(--accent, #c00)" strokeWidth="1.5" />
                        </>
                      );
                    })()}
                  </svg>
                )}
              </div>
            );
          })}
          <div className="hint-line">预热 {tryResult.warmup} 根 K 线后才出第一个信号（与机器人实时行为一致）。</div>
        </div>
      )}
    </div>
  );
}