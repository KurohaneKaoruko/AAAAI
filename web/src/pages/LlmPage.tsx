/** LLM 页：启用开关、模型参数、连通性测试。 */

import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppStore } from "../state/useAppStore";
import type { LLMSection } from "../types";
import { Button, Notice, NumberField, Panel, TextField, Toggle } from "../components/ui";

export function LlmPage({ store }: { store: AppStore }) {
  const config = store.state?.config;
  const [form, setForm] = useState<LLMSection | undefined>(config?.llm);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (config?.llm) setForm(config.llm);
  }, [config?.llm]);

  if (!form) return <div className="loading">加载中…</div>;

  const save = async () => {
    setSaving(true);
    await store.patchConfig({ llm: form });
    setSaving(false);
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testLlm("用一句话说明你已就绪。");
      setTestResult(r.text.slice(0, 300));
      store.toast("success", "LLM 连通正常");
    } catch (err) {
      setTestResult(`测试失败：${(err as Error).message}`);
      store.toast("error", "LLM 测试失败");
    } finally {
      setTesting(false);
    }
  };

  const keyPresent = Boolean(form.apiKey);

  return (
    <div className="page page-llm">
      <Panel
        title="大模型设置"
        subtitle="LLM 作为策略 Agent 的大脑，失败时自动回退规则策略"
        actions={
          <Button variant="primary" onClick={save} busy={saving} disabled={store.state?.status === "running"}>
            保存
          </Button>
        }
      >
        <Toggle
          label="启用 LLM 决策"
          hint={keyPresent ? "密钥已检测到" : `未检测到密钥环境变量 ${form.apiKeyEnv}`}
          checked={form.enabled}
          onChange={(v) => setForm({ ...form, enabled: v })}
        />

        <div className="grid-2">
          <TextField label="接口地址" value={form.baseUrl} onChange={(v) => setForm({ ...form, baseUrl: v })} />
          <TextField label="模型" value={form.model} onChange={(v) => setForm({ ...form, model: v })} />
          <NumberField
            label="温度"
            hint="越低越稳定"
            value={form.temperature}
            step={0.1}
            min={0}
            max={2}
            onChange={(v) => setForm({ ...form, temperature: v })}
          />
          <NumberField
            label="决策间隔"
            hint="每 N 根 K 线问一次模型"
            value={form.decisionInterval}
            min={1}
            max={100}
            onChange={(v) => setForm({ ...form, decisionInterval: v })}
          />
          <TextField
            label="密钥环境变量名"
            value={form.apiKeyEnv}
            onChange={(v) => setForm({ ...form, apiKeyEnv: v })}
          />
          <NumberField
            label="超时（毫秒）"
            value={form.timeoutMs}
            step={1000}
            min={1000}
            onChange={(v) => setForm({ ...form, timeoutMs: v })}
          />
        </div>

        {!keyPresent && (
          <Notice tone="warn">
            未检测到环境变量 <code>{form.apiKeyEnv}</code>。请在项目根目录的 <code>.env</code> 中设置后重启服务；
            未配置密钥时策略会自动以纯规则模式运行。
          </Notice>
        )}
      </Panel>

      <Panel title="连通性测试" subtitle="实际调用一次模型接口">
        <Button variant="primary" onClick={test} busy={testing} disabled={!keyPresent}>
          发送测试请求
        </Button>
        {testResult && (
          <div className={`test-box ${testResult.startsWith("测试失败") ? "down" : "up"}`}>{testResult}</div>
        )}
      </Panel>

      <Panel title="工作方式">
        <div className="explain-box">
          <ul className="notes">
            <li>每 {form.decisionInterval} 根 K 线，把最近 20 根 K 线与市场解读发给模型；</li>
            <li>模型需返回 JSON：<code>{'{"target_weight": 0.3, "confidence": 0.7, "reason": "..."}'}</code>；</li>
            <li>输出越界（不在 0~1）、非 JSON、请求超时 —— 全部回退到动量基线，并打上 [fallback] 标记；</li>
            <li>密钥只从环境变量读取，不写入配置文件、不回显到前端。</li>
          </ul>
        </div>
      </Panel>
    </div>
  );
}