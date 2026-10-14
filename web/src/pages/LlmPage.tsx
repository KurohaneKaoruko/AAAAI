/** LLM 大模型页：多实例管理 + 负载均衡 + 调用统计。 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AppStore } from "../state/useAppStore";
import type { BalanceStrategy, LlmOverview, LlmProfile } from "../types";
import { Badge, Button, Empty, Notice, NumberField, Panel, SelectField, TextField, Toggle } from "../components/ui";
import { ASSET_LABEL } from "../lib/format";

const STRATEGY_HINT: Record<string, string> = {
  "round-robin": "按顺序轮流分配到各实例，流量均匀，适合同规格多 Key。",
  weighted: "按权重比例分配（权重越大分到的请求越多），适合主备或按额度分配。",
  random: "随机分配，实现简单，极端情况下可能短时倾斜。",
  latency: "优先选择历史平均延迟最低的实例，适合多供应商择优。",
};

interface FormState {
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  timeoutMs: number;
  weight: number;
}

const EMPTY_FORM: FormState = {
  label: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  apiKey: "",
  temperature: 0.2,
  timeoutMs: 20000,
  weight: 1,
};

export function LlmPage({ store }: { store: AppStore }) {
  const config = store.state?.config;
  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  const [overview, setOverview] = useState<LlmOverview | null>(null);
  const [strategy, setStrategy] = useState<BalanceStrategy>(config?.llm.strategy ?? "round-robin");
  const [strategyOptions, setStrategyOptions] = useState<{ value: string; label: string }[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    try {
      const data = await api.llmProfiles();
      setProfiles(data.profiles);
      setOverview(data.overview);
      setStrategy(data.strategy as BalanceStrategy);
      setStrategyOptions(data.strategies);
    } catch (err) {
      store.toast("error", (err as Error).message);
    }
  }, [store]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 统计轮询（5s）
  useEffect(() => {
    const t = setInterval(() => void reload(), 5000);
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
        await api.createLlm({ ...form });
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
      <Panel
        title="大模型总开关"
        subtitle={
          config
            ? `当前 ${profiles.filter((p) => p.enabled && p.hasKey).length} / ${profiles.length} 个实例可用`
            : undefined
        }
      >
        <Toggle
          label="启用 LLM 决策"
          hint={
            profiles.length === 0
              ? "尚未添加任何实例 —— 未启用时策略自动以纯规则模式运行"
              : "关闭后策略回退为纯规则（动量）"
          }
          checked={config?.llm.enabled ?? false}
          danger
          onChange={(v) => config && void store.patchConfig({ llm: { ...config.llm, enabled: v } })}
        />

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
                {overview.available}
                <span className="dim" style={{ fontSize: 13 }}> / {overview.total}</span>
              </div>
            </div>
            <div className="card">
              <div className="card-label">累计调用</div>
              <div className="card-value">{overview.calls}</div>
            </div>
            <div className="card">
              <div className="card-label">成功率</div>
              <div className={`card-value ${successRate > 0.9 ? "up" : successRate > 0.5 ? "" : "down"}`}>
                {(successRate * 100).toFixed(1)}%
              </div>
            </div>
            <div className="card">
              <div className="card-label">平均延迟</div>
              <div className="card-value">{overview.avgLatencyMs} ms</div>
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

      <Panel
        title="模型实例"
        subtitle={`${profiles.length} 个`}
        actions={
          <Button variant="primary" onClick={() => { setForm({ ...EMPTY_FORM }); setEditingId(null); }}>
            + 添加实例
          </Button>
        }
      >
        {form && (
          <div className="connection-form">
            <div className="grid-2">
              <TextField label="名称" value={form.label} onChange={(v) => setForm({ ...form, label: v })} placeholder="如：主力 gpt-4o-mini" />
              <TextField label="模型" value={form.model} onChange={(v) => setForm({ ...form, model: v })} />
            </div>
            <TextField
              label="接口地址（OpenAI 兼容）"
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

        {profiles.length === 0 ? (
          <Empty>还没有模型实例。点击右上「添加实例」接入你的大模型。</Empty>
        ) : (
          <div className="connection-list">
            {profiles.map((p) => {
              const rate = p.stats.calls > 0 ? p.stats.success / p.stats.calls : 0;
              const cooling = p.stats.cooldownUntil > Date.now();
              return (
                <div className="connection-item" key={p.id}>
                  <div className="connection-main">
                    <div className="connection-title">
                      <span className="strong">{p.label}</span>
                      <span className="mono dim small">{p.model}</span>
                      {cooling && <Badge tone="down">熔断中</Badge>}
                      {!p.hasKey && <Badge tone="warn">缺密钥</Badge>}
                      {!p.enabled && <Badge>已停用</Badge>}
                      {p.weight > 1 && <Badge tone="accent">权重 {p.weight}</Badge>}
                    </div>
                    <div className="dim small">{p.baseUrl}</div>
                    <div className="llm-stats small">
                      <span>调用 <b className="mono">{p.stats.calls}</b></span>
                      <span>成功率 <b className={`mono ${rate > 0.9 ? "up" : rate < 0.5 ? "down" : ""}`}>{(rate * 100).toFixed(0)}%</b></span>
                      <span>平均延迟 <b className="mono">{p.stats.avgLatencyMs}ms</b></span>
                      {p.stats.lastError && <span className="down">最近错误: {p.stats.lastError.slice(0, 40)}</span>}
                    </div>
                    {results[p.id] && <div className="test-result">{results[p.id]}</div>}
                  </div>
                  <div className="connection-actions">
                    <Button small onClick={() => void test(p)} busy={testing[p.id]}>
                      测试
                    </Button>
                    <Button
                      small
                      onClick={() => {
                        setForm({
                          label: p.label,
                          baseUrl: p.baseUrl,
                          model: p.model,
                          apiKey: "",
                          temperature: p.temperature,
                          timeoutMs: p.timeoutMs,
                          weight: p.weight,
                        });
                        setEditingId(p.id);
                      }}
                    >
                      编辑
                    </Button>
                    <Button small onClick={() => void api.resetLlmStats(p.id).then(reload)}>
                      复位
                    </Button>
                    <Button
                      small
                      variant="ghost"
                      title={p.enabled ? "停用" : "启用"}
                      onClick={() => void api.updateLlm(p.id, { enabled: !p.enabled } as Partial<LlmProfile>).then(reload)}
                    >
                      {p.enabled ? "停用" : "启用"}
                    </Button>
                    <Button
                      small
                      variant="danger"
                      onClick={() => {
                        if (confirm(`删除实例「${p.label}」？`)) {
                          void api.deleteLlm(p.id).then(reload);
                        }
                      }}
                    >
                      删除
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel title="工作方式">
        <div className="explain-box">
          <ul className="notes">
            <li>策略每隔 {config?.llm.decisionInterval ?? 10} 根 K 线，把最近 20 根 K 线与市场解读发给负载均衡器；</li>
            <li>负载均衡器按当前策略在「已启用 + 有密钥 + 未熔断」的实例中挑选一个；</li>
            <li>单个实例连续失败 {3} 次会进入熔断冷却（60 秒），冷却期自动跳过；</li>
            <li>请求失败会自动故障转移到下一个可用实例，全部失败才回退动量基线并打 [fallback] 标记；</li>
            <li>模型需返回 JSON：<code>{'{"target_weight": 0.3, "confidence": 0.7, "reason": "..."}'}</code>，越界视为非法输出。</li>
          </ul>
        </div>
      </Panel>
    </div>
  );
}