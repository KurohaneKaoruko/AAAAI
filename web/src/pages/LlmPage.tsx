/** LLM 大模型页：多实例管理 + 负载均衡 + 调用统计。 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { AppStore } from "../state/useAppStore";
import type { BalanceStrategy, LlmOverview, LlmProfile } from "../types";
import { Badge, Button, Empty, Notice, NumberField, Panel, SelectField, TextField } from "../components/ui";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ASSET_LABEL } from "../lib/format";

/** System One 预设地址/模型（与后端 SYSTEM_ONE_PRESETS 保持一致） */
const PRESET_MAP: Record<string, { baseUrl: string; model: string; label: string }> = {
  "https://jev-api.com/v1": { baseUrl: "https://jev-api.com/v1", model: "jev-latest", label: "Jev (TypeSafe)" },
  "http://127.0.0.1:8080/v1": { baseUrl: "http://127.0.0.1:8080/v1", model: "Laya-latest", label: "Laya（自托管）" },
  "https://dashscope.aliyuncs.com/api/v1": { baseUrl: "https://dashscope.aliyuncs.com/api/v1", model: "qwen-systemone", label: "阿里云百炼" },
};
const PRESETS = {
  chat: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", label: "" },
  systemone: { baseUrl: "https://jev-api.com/v1", model: "jev-latest", label: "Jev 决策模型" },
};

const STRATEGY_HINT: Record<string, string> = {
  "round-robin": "按顺序轮流分配到各实例，流量均匀，适合同规格多 Key。",
  weighted: "按权重比例分配（权重越大分到的请求越多），适合主备或按额度分配。",
  random: "随机分配，实现简单，极端情况下可能短时倾斜。",
  latency: "优先选择历史平均延迟最低的实例，适合多供应商择优。",
};

interface FormState {
  label: string;
  kind: "chat" | "systemone";
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  timeoutMs: number;
  weight: number;
  levels: string;
  levelWeights: string;
}

const EMPTY_FORM: FormState = {
  label: "",
  kind: "chat",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  apiKey: "",
  temperature: 0.2,
  timeoutMs: 20000,
  weight: 1,
  levels: "flat, weak, moderate, strong",
  levelWeights: "0, 0.25, 0.5, 0.9",
};

export function LlmPage({ store }: { store: AppStore }) {
  const config = store.state?.config;
  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  const [overview, setOverview] = useState<LlmOverview | null>(null);
  const [strategy, setStrategy] = useState<BalanceStrategy>(config?.llm.strategy ?? "round-robin");
  const [strategyOptions, setStrategyOptions] = useState<{ value: string; label: string }[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tab, setTab] = useState<"chat" | "systemone" | "balance">("chat");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, string>>({});
  /** 待确认删除的实例（自绘二次确认） */
  const [confirmDel, setConfirmDel] = useState<LlmProfile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { toast } = store;
  /** 轮询从通到断只提醒一次：5s 一次错误 toast 会把屏幕刷满。 */
  const wasOnline = useRef(true);

  const kindList = useMemo(
    () => profiles.filter((p) => p.kind === (tab === "systemone" ? "systemone" : "chat")),
    [profiles, tab],
  );

  const reload = useCallback(
    async (silent = false) => {
      try {
        const data = await api.llmProfiles();
        setProfiles(data.profiles);
        setOverview(data.overview);
        setStrategy(data.strategy as BalanceStrategy);
        setStrategyOptions(data.strategies);
        setLoadError(null);
        if (!wasOnline.current) {
          wasOnline.current = true;
          toast("success", "模型实例状态已恢复");
        }
      } catch (err) {
        setLoadError((err as Error).message);
        if (wasOnline.current) {
          wasOnline.current = false;
          toast("error", `模型实例读取失败：${(err as Error).message}`);
        } else if (!silent) {
          // 手动刷新/操作后的失败仍要反馈（轮询失败已经提醒过一次了）
          toast("error", (err as Error).message);
        }
      } finally {
        setLoaded(true);
      }
    },
    [toast],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // 统计轮询（5s）
  useEffect(() => {
    const t = setInterval(() => void reload(true), 5000);
    return () => clearInterval(t);
  }, [reload]);

  const saveStrategy = async (next: BalanceStrategy) => {
    setStrategy(next);
    if (config) await store.patchConfig({ llm: { ...config.llm, strategy: next } });
  };

  const submit = async () => {
    if (!form) return;
    setBusy(true);
    try {
      if (editingId) {
        await api.updateLlm(editingId, {
          label: form.label,
          baseUrl: form.baseUrl,
          model: form.model,
          temperature: form.temperature,
          timeoutMs: form.timeoutMs,
          weight: form.weight,
          ...(form.apiKey ? { apiKey: form.apiKey } : {}),
        } as Partial<LlmProfile>);
        store.toast("success", "实例已更新");
      } else {
        await api.createLlm({
          ...form,
          levels: form.levels.split(",").map((x) => x.trim()).filter(Boolean),
          levelWeights: form.levelWeights.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)),
        });
        store.toast("success", "实例已添加");
      }
      setForm(null);
      setEditingId(null);
      await reload();
    } catch (err) {
      store.toast("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const test = async (p: LlmProfile) => {
    setTesting((s) => ({ ...s, [p.id]: true }));
    try {
      const r = await api.testLlm(p.id, "用一句话说明：你已就绪。");
      setResults((s) => ({ ...s, [p.id]: r.ok ? `✓ ${r.latencyMs}ms · ${r.message}` : `✗ ${r.message}` }));
    } catch (err) {
      setResults((s) => ({ ...s, [p.id]: `✗ ${(err as Error).message}` }));
    } finally {
      setTesting((s) => ({ ...s, [p.id]: false }));
    }
  };

  const lbTest = async () => {
    try {
      const r = await api.lbTest("用一句话说明：你已就绪。");
      store.toast("success", `负载均衡链路正常（${r.latencyMs}ms）：${r.text.slice(0, 60)}`);
    } catch (err) {
      store.toast("error", `负载均衡调用失败：${(err as Error).message}`);
    }
  };

  const successRate = overview && overview.calls > 0 ? overview.success / overview.calls : 0;

  return (
    <div className="page page-llm">
      <div className="page-tabs">
        <button
          type="button"
          className={`page-tab ${tab === "chat" ? "page-tab-on" : ""}`}
          onClick={() => setTab("chat")}
        >
          对话模型
          <span className="page-tab-count">{profiles.filter((p) => p.kind === "chat").length}</span>
        </button>
        <button
          type="button"
          className={`page-tab ${tab === "systemone" ? "page-tab-on" : ""}`}
          onClick={() => setTab("systemone")}
        >
          决策模型
          <span className="page-tab-count">{profiles.filter((p) => p.kind === "systemone").length}</span>
        </button>
        <button
          type="button"
          className={`page-tab ${tab === "balance" ? "page-tab-on" : ""}`}
          onClick={() => setTab("balance")}
        >
          负载均衡与统计
        </button>
      </div>

      {loadError && (
        <Notice tone="error">
          模型实例读取失败：{loadError}
          {loaded && profiles.length > 0 ? "（当前显示的是上次成功读取的数据）" : ""}
        </Notice>
      )}

      {tab === "balance" && (
        <>
      <Panel
        title="模型池与负载均衡"
        subtitle={
          config
            ? `当前 ${profiles.filter((p) => p.enabled && p.hasKey).length} / ${profiles.length} 个实例可用`
            : undefined
        }
      >
        <div className="source-status">
          <span className="source-status-label">当前决策来源</span>
          <span className={`source-chip source-${config?.strategy.decisionSource ?? "rules"}`}>
            {config?.strategy.decisionSource === "rules"
              ? "量化交易（动量）"
              : config?.strategy.decisionSource === "chat"
                ? "对话模型池"
                : "决策模型池"}
          </span>
          <span className="dim small">
            在「策略」页顶部切换决策来源；这里管理的是模型实例本身。
          </span>
        </div>

        <div className="grid-2">
          <NumberField
            label="决策间隔"
            hint="每 N 根 K 线问一次模型（限流/控费）"
            value={config?.llm.decisionInterval ?? 10}
            min={1}
            max={200}
            onChange={(v) => config && void store.patchConfig({ llm: { ...config.llm, decisionInterval: v } })}
          />
          <SelectField
            label="负载均衡策略"
            value={strategy}
            onChange={(v) => void saveStrategy(v as BalanceStrategy)}
            options={
              strategyOptions.length > 0
                ? strategyOptions
                : [{ value: "round-robin", label: "轮询（Round Robin）" }]
            }
          />
        </div>
        {STRATEGY_HINT[strategy] && <div className="hint-line">{STRATEGY_HINT[strategy]}</div>}

        {overview && overview.total > 0 && (
          <div className="cards llm-overview">
            <div className="card">
              <div className="card-label">可用实例</div>
              <div className="card-value">
                <span className={overview.available === 0 ? "down" : overview.available < overview.total ? "" : "up"}>
                  {overview.available}
                </span>
                <span className="dim" style={{ fontSize: 13 }}> / {overview.total}</span>
              </div>
            </div>
            <div className="card">
              <div className="card-label">累计调用</div>
              <div className="card-value">{overview.calls.toLocaleString("zh-CN")}</div>
            </div>
            <div className="card">
              <div className="card-label">成功率</div>
              <div className={`card-value ${successRate > 0.9 ? "up" : successRate > 0.5 ? "" : "down"}`}>
                {(successRate * 100).toFixed(1)}%
              </div>
              {/* 失败次数不该藏在成功率里：>0 就要让用户看见还有几次没成 */}
              {overview.calls - overview.success > 0 && (
                <div className="card-label dim" style={{ marginTop: 2 }}>
                  失败 {overview.calls - overview.success} 次
                </div>
              )}
            </div>
            <div className="card">
              <div className="card-label">平均延迟</div>
              <div className="card-value">
                {overview.avgLatencyMs.toLocaleString("zh-CN")}
                <span className="dim" style={{ fontSize: 13 }}> ms</span>
              </div>
            </div>
            <div className="card">
              <div className="card-label">调度自检</div>
              <div style={{ marginTop: 4 }}>
                <Button small onClick={() => void lbTest()} disabled={overview.available === 0}>
                  发一次请求
                </Button>
              </div>
            </div>
          </div>
        )}
      </Panel>

        </>
      )}

      {tab !== "balance" && (
      <Panel
        title={tab === "systemone" ? "决策模型实例（System One）" : "对话模型实例"}
        subtitle={`对话 ${profiles.filter((p) => p.kind === "chat").length} 个 · 决策 ${profiles.filter((p) => p.kind === "systemone").length} 个`}
        actions={
          <Button
            variant={form ? "default" : "primary"}
            onClick={() => {
              // 表单已经打开时再点一次是「取消」：否则会把用户刚填的内容静默清空。
              if (form) {
                setForm(null);
                setEditingId(null);
                return;
              }
              const kind = tab === "systemone" ? "systemone" : "chat";
              const preset = PRESETS[kind];
              setForm({ ...EMPTY_FORM, kind, baseUrl: preset.baseUrl, model: preset.model });
              setEditingId(null);
            }}
          >
            {form ? "取消" : `+ 添加${tab === "systemone" ? "决策模型" : "对话模型"}`}
          </Button>
        }
      >
        {form && (
          <div className="connection-form">
            <div className="grid-2">
              <TextField
                label="名称"
                hint="修改后不再跟随预设自动更新"
                value={form.label}
                onChange={(v) => setForm({ ...form, label: v })}
                placeholder="如：主力 gpt-4o-mini"
              />
              <TextField label="模型" required value={form.model} onChange={(v) => setForm({ ...form, model: v })} />
            </div>
            {form.kind === "systemone" && (
              <SelectField
                label="厂商预设"
                hint="切换预设会同步模型与名称（名称被手动改过则保留）"
                value={form.baseUrl}
                onChange={(v) => {
                  const p = PRESET_MAP[v];
                  if (!p) return;
                  // 名称若仍是上一个预设的自动名或为空，则跟着切换
                  const autoNames = Object.values(PRESET_MAP).map((x) => x.label);
                  const auto = form.label.trim() === "" || autoNames.includes(form.label.trim());
                  setForm({
                    ...form,
                    baseUrl: p.baseUrl,
                    model: p.model,
                    label: auto ? p.label : form.label,
                  });
                }}
                options={[
                  { value: "https://jev-api.com/v1", label: "Jev 官方（jev-api.com）" },
                  { value: "http://127.0.0.1:8080/v1", label: "Laya（本地自托管）" },
                  { value: "https://dashscope.aliyuncs.com/api/v1", label: "阿里云百炼" },
                ]}
              />
            )}
            {form.kind === "systemone" && (
              <div className="grid-2">
                <TextField
                  label="档位标签（从低到高，逗号分隔）"
                  value={form.levels}
                  onChange={(v) => setForm({ ...form, levels: v })}
                />
                <TextField
                  label="档位对应仓位权重（0~1，逗号分隔）"
                  value={form.levelWeights}
                  onChange={(v) => setForm({ ...form, levelWeights: v })}
                />
              </div>
            )}
            <TextField
              label="接口地址（OpenAI 兼容）"
              required
              value={form.baseUrl}
              onChange={(v) => setForm({ ...form, baseUrl: v })}
            />
            <TextField
              label={editingId ? "API Key（留空则不修改）" : "API Key"}
              type="password"
              value={form.apiKey}
              onChange={(v) => setForm({ ...form, apiKey: v })}
              placeholder="sk-..."
            />
            <div className="grid-2">
              <NumberField label="温度" value={form.temperature} step={0.1} min={0} max={2} onChange={(v) => setForm({ ...form, temperature: v })} />
              <NumberField label="超时（毫秒）" value={form.timeoutMs} step={1000} min={1000} onChange={(v) => setForm({ ...form, timeoutMs: v })} />
              <NumberField label="权重（加权策略生效）" value={form.weight} min={1} max={100} onChange={(v) => setForm({ ...form, weight: v })} />
            </div>
            <Notice tone="info">
              密钥保存在服务端 data/secrets.json（0600，gitignore），不会回显到浏览器。
              支持任意 OpenAI 兼容端点：OpenAI、DeepSeek、Moonshot、通义、本地 Ollama 等。
            </Notice>
            <div className="btn-row">
              <Button variant="primary" onClick={() => void submit()} busy={busy} disabled={!form.baseUrl || !form.model}>
                {editingId ? "保存修改" : "添加实例"}
              </Button>
              <Button onClick={() => { setForm(null); setEditingId(null); }}>取消</Button>
            </div>
          </div>
        )}

        {!loaded ? (
          <div className="loading-inline">正在读取模型实例…</div>
        ) : kindList.length === 0 ? (
          <Empty>
            还没有{tab === "systemone" ? "决策模型" : "对话模型"}实例。
            点击右上「添加{tab === "systemone" ? "决策模型" : "对话模型"}」接入。
          </Empty>
        ) : (
          <div className="connection-list">
            {kindList.map((p) => (
              <ProfileCard
                key={p.id}
                p={p}
                results={results}
                testing={testing}
                onTest={test}
                onEdit={(x) => {
                  setForm({
                    label: x.label,
                    kind: x.kind,
                    baseUrl: x.baseUrl,
                    model: x.model,
                    apiKey: "",
                    temperature: x.temperature,
                    timeoutMs: x.timeoutMs,
                    weight: x.weight,
                    levels: (x.levels ?? []).join(", "),
                    levelWeights: (x.levelWeights ?? []).join(", "),
                  });
                  setEditingId(x.id);
                  setTab(x.kind);
                }}
                onToggle={(x) => {
                  void (async () => {
                    try {
                      await api.updateLlm(x.id, { enabled: !x.enabled } as Record<string, unknown>);
                      toast("success", `${x.label} 已${x.enabled ? "停用" : "启用"}`);
                      await reload(true);
                    } catch (err) {
                      toast("error", `操作失败：${(err as Error).message}`);
                    }
                  })();
                }}
                onReset={(x) => {
                  void (async () => {
                    try {
                      await api.resetLlmStats(x.id);
                      toast("success", `${x.label} 的调用统计已复位`);
                      await reload(true);
                    } catch (err) {
                      toast("error", `复位失败：${(err as Error).message}`);
                    }
                  })();
                }}
                onDelete={(x) => setConfirmDel(x)}
              />
            ))}
          </div>
        )}
      </Panel>
      )}
      {tab === "balance" && (
      <Panel title="工作方式">
        <div className="explain-box">
          <ul className="notes">
            <li>策略每隔 {config?.llm.decisionInterval ?? 10} 根 K 线，把最近 20 根 K 线与市场解读发给负载均衡器；</li>
            <li>负载均衡器按当前策略在「已启用 + 有密钥 + 未熔断」的实例中挑选一个；</li>
            <li>单个实例连续失败 {3} 次会进入熔断冷却（60 秒），冷却期自动跳过；</li>
            <li>请求失败会自动故障转移到下一个可用实例，全部失败才回退动量基线并打 [fallback] 标记；</li>
            <li>对话模型需返回 JSON：<code>{'{"target_weight": 0.3, "confidence": 0.7, "reason": "..."}'}</code>，越界视为非法输出；</li>
            <li>决策模型走 System One 协议：只认 <code>POST /v1/systemone</code>，按档位概率换算目标仓位（Jev / laya / 百炼）；</li>
            <li>两类模型各自成池，互不混用；策略通过「模拟对照」页可以横向比较它们的效果。</li>
          </ul>
        </div>
      </Panel>
      )}

      {/* 删除模型实例：删了之后引用它的机器人会找不到决策模型，必须说清再删 */}
      <ConfirmDialog
        open={confirmDel !== null}
        title={`删除实例「${confirmDel?.label ?? ""}」？`}
        message="引用这个实例的机器人将失去决策模型（混合决策只缺一个也跑不起来），删除不可恢复。"
        confirmText="删除实例"
        busy={deleting}
        onConfirm={() => {
          if (!confirmDel) return;
          setDeleting(true);
          void (async () => {
            try {
              await api.deleteLlm(confirmDel.id);
              toast("success", `已删除实例「${confirmDel.label}」`);
              setConfirmDel(null);
              await reload(true);
            } catch (err) {
              toast("error", `删除失败：${(err as Error).message}`);
            } finally {
              setDeleting(false);
            }
          })();
        }}
        onCancel={() => setConfirmDel(null)}
      />
    </div>
  );
}

/** 单个模型实例卡片：状态徽章 + 调用统计 + 操作。 */
function ProfileCard({
  p,
  results,
  testing,
  onTest,
  onEdit,
  onToggle,
  onReset,
  onDelete,
}: {
  p: LlmProfile;
  results: Record<string, string>;
  testing: Record<string, boolean>;
  onTest: (p: LlmProfile) => void;
  onEdit: (p: LlmProfile) => void;
  onToggle: (p: LlmProfile) => void;
  onReset: (p: LlmProfile) => void;
  onDelete: (p: LlmProfile) => void;
}) {
  const rate = p.stats.calls > 0 ? p.stats.success / p.stats.calls : 0;
  const cooling = p.stats.cooldownUntil > Date.now();
  return (
    <div className="connection-item">
      <div className="connection-main">
        <div className="connection-title">
          <span className="strong">{p.label}</span>
          <span className="mono dim small">{p.model}</span>
          {/* 健康一眼判：绿=可用；黄=冷却/缺钥；灰=停用。供 5s 轮询刷新。 */}
          {p.enabled && p.hasKey && !cooling && <span className="chip chip-sm chip-ok">可用</span>}
          {p.kind === "systemone" && <Badge tone="accent">决策模型</Badge>}
          {cooling && <Badge tone="down">熔断中</Badge>}
          {!p.hasKey && <Badge tone="warn">缺密钥</Badge>}
          {!p.enabled && <Badge>已停用</Badge>}
          {p.weight > 1 && <Badge tone="accent">权重 {p.weight}</Badge>}
        </div>
        <div className="dim small">{p.baseUrl}</div>
        {p.kind === "systemone" && p.levels?.length > 0 && (
          <div className="dim small">
            档位 {p.levels.join(" → ")} · 权重 {p.levelWeights.join(" / ")}
          </div>
        )}
        <div className="llm-stats small">
          <span>调用 <b className="mono">{p.stats.calls}</b></span>
          <span>成功率 <b className={`mono ${rate > 0.9 ? "up" : rate < 0.5 ? "down" : ""}`}>{(rate * 100).toFixed(0)}%</b></span>
          <span>平均延迟 <b className="mono">{p.stats.avgLatencyMs}ms</b></span>
          {p.stats.lastError && <span className="down">最近错误: {p.stats.lastError.slice(0, 40)}</span>}
        </div>
        {results[p.id] && <div className="test-result">{results[p.id]}</div>}
      </div>
      <div className="connection-actions">
        <Button small onClick={() => onTest(p)} busy={testing[p.id]}>测试</Button>
        <Button small onClick={() => onEdit(p)}>编辑</Button>
        <Button small onClick={() => onReset(p)}>复位</Button>
        <Button small variant="ghost" onClick={() => onToggle(p)}>{p.enabled ? "停用" : "启用"}</Button>
        <Button small variant="danger" onClick={() => onDelete(p)}>删除</Button>
      </div>
    </div>
  );
}
