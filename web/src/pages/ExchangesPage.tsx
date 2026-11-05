/** 交易所连接：目录浏览 + 连接 CRUD + 连通性测试。 */

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AppStore } from "../state/useAppStore";
import type { AdapterMeta, Connection } from "../types";
import { AssetBadge } from "../components/Shell";
import { Button, Empty, Notice, Panel, SelectField, TextField, Toggle } from "../components/ui";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ConnectionSymbols } from "../components/CandidatePool";
import { ASSET_LABEL, dateTime } from "../lib/format";

export function ExchangesPage({ store }: { store: AppStore }) {
  const { adapters, connections, state } = store;
  const [creating, setCreating] = useState(false);
  /** 从目录卡片点「添加连接」时预选的交易所；null = 表单自己取第一条 */
  const [createAdapterId, setCreateAdapterId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [testing, setTesting] = useState<Record<string, "loading" | "ok" | "fail">>({});
  const [results, setResults] = useState<Record<string, string>>({});
  /** 待确认删除的连接 */
  const [confirmDel, setConfirmDel] = useState<Connection | null>(null);
  const [deleting, setDeleting] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);

  // 表单在目录上方：从下方卡片点「添加连接」后如果不滚过去，用户会以为没反应。
  useEffect(() => {
    if (creating) formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [creating, createAdapterId]);

  const doDelete = async () => {
    if (!confirmDel) return;
    setDeleting(true);
    try {
      await api.deleteConnection(confirmDel.id);
      setConfirmDel(null);
      await store.reloadConnections();
      store.toast("success", `已删除连接「${confirmDel.label}」`);
    } catch (err) {
      store.toast("error", `删除失败：${(err as Error).message}`);
    } finally {
      setDeleting(false);
    }
  };

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
    if (!state?.config) {
      store.toast("error", "配置还没加载好，请稍后重试");
      return;
    }
    const ok = await store.patchConfig({
      execution: { ...state.config.execution, connectionId: c.id },
    });
    if (ok) store.toast("success", `已将 ${c.label} 设为默认连接`);
  };

  return (
    <div className="page page-exchanges">
      <Panel
        title="交易所目录"
        subtitle="支持加密货币与股票，点击卡片可快速添加连接"
        actions={
          <Button
            variant="primary"
            onClick={() => {
              const next = !creating;
              setCreating(next);
              setCreateAdapterId(null);
              // 新建和编辑是两张表单，别让它们同时挂在页面上
              if (next) setEditing(null);
            }}
          >
            {creating ? "取消" : "+ 新建连接"}
          </Button>
        }
      >
        {creating && (
          <div ref={formRef}>
            <ConnectionForm
              key={createAdapterId ?? "auto"}
              store={store}
              initialAdapterId={createAdapterId ?? undefined}
              onDone={() => {
                setCreating(false);
                setCreateAdapterId(null);
              }}
            />
          </div>
        )}

        <div className="adapter-grid">
          {adapters.map((a) => (
            <div className="adapter-card" key={a.id}>
              <div className="adapter-head">
                <span className="adapter-name">{a.name}</span>
                <AssetBadge assetClass={a.assetClass} />
              </div>
              <p className="adapter-desc">{a.description}</p>
              <div className="adapter-caps">
                {a.tradingMode === "futures" && <span className="cap-on">合约</span>}
                {a.id === "gate" && <span className="cap-on">现货 / 合约可选</span>}
                <span className={a.supportsTrading ? "cap-on" : "cap-off"}>
                  {a.supportsTrading
                    ? "支持下单"
                    : a.tradingMode === "futures"
                      ? "仅行情 · 本地撮合"
                      : "仅行情"}
                </span>
                {a.requiresKeys && <span className="cap-off">需 API Key</span>}
                {a.supportsTestnet && <span className="cap-on">支持测试网</span>}
                <span className="cap-off">{a.klineIntervals.join(" / ")}</span>
              </div>
              <Button
                small
                onClick={() => {
                  setEditing(null);
                  setCreateAdapterId(a.id);
                  setCreating(true);
                }}
              >
                添加连接
              </Button>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="我的连接" subtitle={`${connections.length} 个`}>
        {connections.length === 0 ? (
          <Empty>还没有连接。点上方「新建连接」，或直接点交易所目录卡片里的「添加连接」。</Empty>
        ) : (
          <div className="connection-list">
            {connections.map((c) => (
              <div className="connection-item" key={c.id}>
                <div className="connection-row">
                  <div className="connection-main">
                  <div className="connection-title">
                    <span className="strong">{c.label}</span>
                    <span className="dim small">{c.adapter.name}</span>
                    {c.tradingMode === "futures" && <span className="chip chip-sm chip-accent">合约</span>}
                    {c.testnet && <span className="chip chip-sm">测试网</span>}
                    {defaultConnectionId === c.id && <span className="chip chip-sm chip-accent">默认</span>}
                    {/* 连接健康一眼可见：最近一次测试通过 = OK，失败 = 异常，没测过不打分 */}
                    {testing[c.id] === "ok" && <span className="chip chip-sm chip-ok">连通</span>}
                    {testing[c.id] === "fail" && <span className="chip chip-sm chip-live">异常</span>}
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
                  <Button
                    small
                    onClick={() => void setDefault(c)}
                    disabled={defaultConnectionId === c.id}
                    title={defaultConnectionId === c.id ? "已经是默认连接" : "新机器人默认使用这个连接"}
                  >
                    {defaultConnectionId === c.id ? "默认连接" : "设为默认"}
                  </Button>
                  <Button small onClick={() => { setEditing(c); setCreating(false); }}>
                    编辑
                  </Button>
                  <Button
                    small
                    variant="danger"
                    onClick={() => setConfirmDel(c)}
                  >
                    删除
                  </Button>
                </div>
              </div>

              {/* 标的就地管理：这个连接交易哪些资产，直接在连接卡片里配，
                  不再跳去单独的候选池设置页。默认收起，点开即用。 */}
              <ConnectionSymbols store={store} connectionId={c.id} />
              </div>
            ))}
          </div>
        )}
        {editing && (
          <ConnectionForm
            key={editing.id}
            store={store}
            editing={editing}
            onDone={() => setEditing(null)}
          />
        )}
      </Panel>

      {/* 删除连接不可撤销：机器人可能还挂在上面。自绘弹窗把后果说清再让用户按。 */}
      <ConfirmDialog
        open={confirmDel !== null}
        title={`删除连接「${confirmDel?.label ?? ""}」？`}
        message="删除后引用这条连接的机器人将无法拉取行情，需要重新配置。此操作不可恢复。"
        confirmText="删除连接"
        busy={deleting}
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDel(null)}
      />
    </div>
  );
}

function ConnectionForm({
  store,
  editing,
  initialAdapterId,
  onDone,
}: {
  store: AppStore;
  editing?: Connection | null;
  /** 从目录卡片点进来的交易所；不传则用目录第一条 */
  initialAdapterId?: string;
  onDone: () => void;
}) {
  const [adapterId, setAdapterId] = useState(editing?.adapterId ?? initialAdapterId ?? "");
  const [label, setLabel] = useState(editing?.label ?? "");
  const [testnet, setTestnet] = useState(editing?.testnet ?? true);
  /** 连接级交易模式：Gate 用一条连接同时覆盖现货与永续，模式必须由这里选 */
  const [tradingMode, setTradingMode] = useState<"spot" | "futures">(editing?.tradingMode ?? "spot");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!adapterId && store.adapters.length > 0) setAdapterId(store.adapters[0]!.id);
  }, [store.adapters, adapterId]);

  const adapter: AdapterMeta | undefined = store.adapters.find((a) => a.id === adapterId);
  /**
   * 目录元信息没有「支持哪些交易模式」的字段（后端未暴露），当前只有 Gate
   * 是现货/合约双模。等后端把能力声明出来，这里改成读元信息即可。
   */
  const dualMode = adapter?.id === "gate";
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
        ...(dualMode ? { tradingMode } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(apiSecret ? { apiSecret } : {}),
      };
      if (editing) {
        await api.updateConnection(editing.id, body);
        store.toast(
          "success",
          editing.tradingMode !== tradingMode
            ? `连接已更新，交易模式切换为${tradingMode === "futures" ? "合约" : "现货"}`
            : "连接已更新",
        );
      } else {
        await api.createConnection(body);
        store.toast(
          "success",
          `连接已创建${dualMode ? `（${tradingMode === "futures" ? "合约" : "现货"}模式）` : ""}`,
        );
      }
      await store.reloadConnections();
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
          onChange={(v) => {
            setAdapterId(v);
            // 切到只支持单一模式的交易所时，别把上一条 Gate 的合约模式带过去
            if (v !== "gate") setTradingMode("spot");
          }}
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
          {dualMode && (
            <SelectField
              label="交易模式"
              hint="决定这条连接跑现货对还是 USDT 永续；切换后引用它的机器人会按新模式重建"
              value={tradingMode}
              options={[
                { value: "spot", label: "现货（现货对，不支持做空）" },
                { value: "futures", label: "合约（USDT 永续，保证金记账、允许做空）" },
              ]}
              onChange={(v) => setTradingMode(v as "spot" | "futures")}
            />
          )}
          {(dualMode ? tradingMode === "futures" : adapter.tradingMode === "futures") && (
            <Notice tone="warn">
              合约模式：真实合约行情 + 本地保证金记账，策略可直接做空。
              当前<b>不发送真实合约订单</b>，也不模拟资金费、维持保证金与强平；
              不要拿本地撮合结果当作真实收益证据。
            </Notice>
          )}
          {dualMode && (
            <Notice tone="info">
              {tradingMode === "futures"
                ? "一条连接覆盖现货与永续：当前选合约；切回现货即可交易现货对，标的按同一代码解析。"
                : "一条连接覆盖现货与永续：当前选现货；需要做空或保证金记账时，把「交易模式」切到合约。"}
            </Notice>
          )}
          {editing && dualMode && (editing.tradingMode ?? "spot") !== tradingMode && (
            <Notice tone="warn">
              你正在切换交易模式。保存后，引用这条连接的机器人会按新模式重建（做空许可与记账方式都会改变），
              建议先停止相关机器人再切换。
            </Notice>
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
              hint="只影响下单/账户；K 线与候选池行情始终走主网真实数据"
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