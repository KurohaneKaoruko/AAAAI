/** 交易所连接：目录浏览 + 连接 CRUD + 连通性测试。 */

import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppStore } from "../state/useAppStore";
import type { AdapterMeta, Connection } from "../types";
import { AssetBadge } from "../components/Shell";
import { Button, Empty, Notice, Panel, SelectField, TextField, Toggle } from "../components/ui";
import { ASSET_LABEL, dateTime } from "../lib/format";

export function ExchangesPage({ store }: { store: AppStore }) {
  const { adapters, connections, state } = store;
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [testing, setTesting] = useState<Record<string, "loading" | "ok" | "fail">>({});
  const [results, setResults] = useState<Record<string, string>>({});

  const defaultConnectionId = state?.config?.execution?.connectionId ?? "";

  const test = async (c: Connection) => {
    setTesting((p) => ({ ...p, [c.id]: "loading" }));
    try {
      const r = await api.testConnection(c.id);
      setResults((p) => ({ ...p, [c.id]: r.message }));
      setTesting((p) => ({ ...p, [c.id]: r.ok ? "ok" : "fail" }));
    } catch (err) {
      setResults((p) => ({ ...p, [c.id]: (err as Error).message }));
      setTesting((p) => ({ ...p, [c.id]: "fail" }));
    }
  };

  const setDefault = async (c: Connection) => {
    await store.patchConfig({ execution: { ...state!.config.execution, connectionId: c.id } });
    store.toast("success", `已将 ${c.label} 设为默认连接`);
  };

  return (
    <div className="page page-exchanges">
      <Panel
        title="交易所目录"
        subtitle="支持加密货币与股票，点击卡片可快速添加连接"
        actions={
          <Button variant="primary" onClick={() => setCreating((v) => !v)}>
            {creating ? "取消" : "+ 新建连接"}
          </Button>
        }
      >
        {creating && <ConnectionForm store={store} onDone={() => setCreating(false)} />}

        <div className="adapter-grid">
          {adapters.map((a) => (
            <div className="adapter-card" key={a.id}>
              <div className="adapter-head">
                <span className="adapter-name">{a.name}</span>
                <AssetBadge assetClass={a.assetClass} />
              </div>
              <p className="adapter-desc">{a.description}</p>
              <div className="adapter-caps">
                <span className={a.supportsTrading ? "cap-on" : "cap-off"}>
                  {a.supportsTrading ? "支持下单" : "仅行情"}
                </span>
                {a.requiresKeys && <span className="cap-off">需 API Key</span>}
                {a.supportsTestnet && <span className="cap-on">支持测试网</span>}
                <span className="cap-off">{a.klineIntervals.join(" / ")}</span>
              </div>
              <Button small onClick={() => { setCreating(true); setEditing(null); (window as unknown as { __pickAdapter?: string }).__pickAdapter = a.id; }}>
                添加连接
              </Button>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="我的连接" subtitle={`${connections.length} 个`}>
        {connections.length === 0 ? (
          <Empty>还没有连接。点击上方「新建连接」或从目录里选一个交易所。</Empty>
        ) : (
          <div className="connection-list">
            {connections.map((c) => (
              <div className="connection-item" key={c.id}>
                <div className="connection-main">
                  <div className="connection-title">
                    <span className="strong">{c.label}</span>
                    <span className="dim small">{c.adapter.name}</span>
                    {c.testnet && <span className="chip chip-sm">测试网</span>}
                    {defaultConnectionId === c.id && <span className="chip chip-sm chip-accent">默认</span>}
                  </div>
                  <div className="dim small">
                    ID {c.id} · 创建于 {dateTime(c.createdAt)} · 密钥 {c.hasKey ? "已配置" : "未配置"}
                    {c.adapter.requiresKeys && !c.hasKey ? "（仅行情可用）" : ""}
                  </div>
                  {results[c.id] && (
                    <div className={`test-result ${testing[c.id] === "ok" ? "up" : testing[c.id] === "fail" ? "down" : "dim"}`}>
                      {results[c.id]}
                    </div>
                  )}
                </div>
                <div className="connection-actions">
                  <Button small onClick={() => void test(c)} busy={testing[c.id] === "loading"}>
                    测试
                  </Button>
                  <Button small onClick={() => void setDefault(c)}>
                    设为默认
                  </Button>
                  <Button small onClick={() => setEditing(c)}>
                    编辑
                  </Button>
                  <Button
                    small
                    variant="danger"
                    onClick={async () => {
                      if (confirm(`确定删除连接「${c.label}」？`)) {
                        await api.deleteConnection(c.id);
                        await store.reloadConnections();
                        store.toast("info", "连接已删除");
                      }
                    }}
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {editing && <ConnectionForm store={store} editing={editing} onDone={() => setEditing(null)} />}
      </Panel>
    </div>
  );
}

function ConnectionForm({
  store,
  editing,
  onDone,
}: {
  store: AppStore;
  editing?: Connection | null;
  onDone: () => void;
}) {
  const [adapterId, setAdapterId] = useState(editing?.adapterId ?? "");
  const [label, setLabel] = useState(editing?.label ?? "");
  const [testnet, setTestnet] = useState(editing?.testnet ?? true);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!adapterId && store.adapters.length > 0) {
      const pre = (window as unknown as { __pickAdapter?: string }).__pickAdapter;
      setAdapterId(pre ?? store.adapters[0]!.id);
    }
  }, [store.adapters, adapterId]);

  const adapter: AdapterMeta | undefined = store.adapters.find((a) => a.id === adapterId);
  useEffect(() => {
    if (adapter && !editing && !label) setLabel(`${adapter.name} 连接`);
  }, [adapter, editing, label]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        adapterId,
        label: label || `${adapter?.name ?? "新"} 连接`,
        testnet,
        ...(apiKey ? { apiKey } : {}),
        ...(apiSecret ? { apiSecret } : {}),
      };
      if (editing) {
        await api.updateConnection(editing.id, body);
        store.toast("success", "连接已更新");
      } else {
        await api.createConnection(body);
        store.toast("success", "连接已创建");
      }
      await store.reloadConnections();
      (window as unknown as { __pickAdapter?: string }).__pickAdapter = undefined;
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connection-form">
      <div className="grid-2">
        <SelectField
          label="交易所"
          value={adapterId}
          onChange={setAdapterId}
          options={store.adapters.map((a) => ({ value: a.id, label: `${a.name}（${ASSET_LABEL[a.assetClass]}）` }))}
        />
        <TextField label="连接名称" value={label} onChange={setLabel} placeholder="如：币安主账户" />
      </div>
      {adapter && (
        <>
          <div className="hint-line">{adapter.description}</div>
          {adapter.notes && (
            <ul className="notes">
              {adapter.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          {adapter.keyFields.map((f) => (
            <TextField
              key={f.key}
              label={`${f.label}${editing && !f.secret ? "（留空则不修改）" : ""}`}
              value={f.key === "apiKey" ? apiKey : apiSecret}
              type={f.secret ? "password" : "text"}
              placeholder={f.placeholder ?? ""}
              onChange={f.key === "apiKey" ? setApiKey : setApiSecret}
            />
          ))}
          {adapter.supportsTestnet && (
            <Toggle
              label="使用测试网 / 模拟盘"
              hint="强烈建议先用测试网验证"
              checked={testnet}
              onChange={setTestnet}
            />
          )}
        </>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <Notice tone="info">
        密钥保存在服务端 data/secrets.json（权限 0600，已被 .gitignore 忽略），不会回显到浏览器。
      </Notice>
      <div className="btn-row">
        <Button variant="primary" onClick={submit} busy={busy} disabled={!adapterId}>
          {editing ? "保存修改" : "创建连接"}
        </Button>
        <Button onClick={onDone}>取消</Button>
      </div>
    </div>
  );
}