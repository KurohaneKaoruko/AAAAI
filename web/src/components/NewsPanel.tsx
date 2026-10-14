/**
 * 新闻情报面板：开关、新闻源、抓取、列表。
 *
 * 明确告诉用户：新闻是外部不可信内容，只作参考，不直接触发交易。
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AppStore } from "../state/useAppStore";
import type { NewsItem, NewsStatus, NewsProviderConfig } from "../types";
import { Button, Empty, Notice, NumberField, Panel, TextField, Toggle } from "./ui";
import { dateTime } from "../lib/format";

export function NewsPanel({ store }: { store: AppStore }) {
  const cfg = store.state?.config?.news;
  const [items, setItems] = useState<NewsItem[]>([]);
  const [status, setStatus] = useState<NewsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<NewsProviderConfig>({ id: "", label: "", url: "", assetClass: "any" });

  const reload = useCallback(async () => {
    try {
      const d = await api.news();
      setItems(d.items);
      setStatus(d.status);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!cfg) return null;

  const save = async (patch: Partial<typeof cfg>) => {
    try {
      await store.patchConfig({ news: { ...cfg, ...patch } } as never);
    } catch (err) {
      store.toast("error", (err as Error).message);
    }
  };

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.refreshNews(store.state?.symbols);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addProvider = async () => {
    if (!draft.url.trim()) return;
    await save({ providers: [...cfg.providers, { ...draft, id: draft.id || `p${Date.now().toString(36)}` }] });
    setDraft({ id: "", label: "", url: "", assetClass: "any" });
  };

  const removeProvider = (id: string) => save({ providers: cfg.providers.filter((p) => p.id !== id) });

  return (
    <Panel
      title="新闻情报"
      subtitle="让决策模型知道「发生了什么」"
      actions={
        <Button small onClick={refresh} busy={busy} disabled={!cfg.enabled}>
          立即抓取
        </Button>
      }
    >
      <Toggle
        label="启用新闻（外部内容不可信，仅作参考，不会直接触发下单）"
        checked={cfg.enabled}
        onChange={(v) => void save({ enabled: v })}
      />

      {cfg.enabled && (
        <>
          <div className="grid-3">
            <NumberField
              label="时效"
              hint={`只看 ${cfg.maxAgeHours} 小时内`}
              value={cfg.maxAgeHours}
              min={1}
              max={168}
              onChange={(v) => void save({ maxAgeHours: v })}
            />
            <NumberField
              label="每标的上限"
              value={cfg.maxPerSymbol}
              min={1}
              max={20}
              onChange={(v) => void save({ maxPerSymbol: v })}
            />
            <NumberField
              label="抓取间隔"
              hint={`${Math.round(cfg.refreshMs / 60000)} 分钟`}
              value={Math.round(cfg.refreshMs / 60000)}
              min={1}
              max={120}
              onChange={(v) => void save({ refreshMs: v * 60_000 })}
            />
          </div>

          <Toggle
            label="把新闻写进分析 prompt"
            checked={cfg.includeInAnalysis}
            onChange={(v) => void save({ includeInAnalysis: v })}
          />

          <div className="symbol-picker">
            <div className="symbol-picker-head">新闻源（RSS/Atom，{"{symbol}"} 会替换为标的代码）</div>
            <div className="field-grid-inline">
              <TextField label="名称" value={draft.label} onChange={(v) => setDraft({ ...draft, label: v })} />
              <TextField
                label="地址模板"
                value={draft.url}
                placeholder="https://example.com/rss?kw={symbol}"
                onChange={(v) => setDraft({ ...draft, url: v })}
              />
            </div>
            <div className="btn-row" style={{ margin: 0 }}>
              <Button small onClick={addProvider} disabled={!draft.url.trim()}>
                添加源
              </Button>
              <span className="dim small">没有配置源时不会抓取任何内容。</span>
            </div>
            {cfg.providers.length > 0 && (
              <div className="chip-row" style={{ marginTop: 8 }}>
                {cfg.providers.map((p) => (
                  <span key={p.id} className="symbol-chip symbol-on" title={p.url}>
                    {p.label || p.id}
                    <button type="button" className="chip-x" onClick={() => void removeProvider(p.id)}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {status && status.errors.length > 0 && (
            <Notice tone="warn">
              {status.errors.map((e) => `${e.provider}: ${e.message}`).join("；")}（其它源不受影响）
            </Notice>
          )}
          {error && <Notice tone="error">{error}</Notice>}

          <div className="news-list">
            {items.length === 0 ? (
              <Empty>
                还没有新闻。{cfg.providers.length === 0 ? "先在上面添加一个新闻源。" : "点「立即抓取」试试。"}
              </Empty>
            ) : (
              items.slice(0, 40).map((n) => (
                <div className={`news-row news-${n.sentimentLabel}`} key={n.id}>
                  <span className="news-sym mono">{n.symbol || "全市场"}</span>
                  <span className="news-title">{n.title}</span>
                  <span className="news-src dim small">{n.source}</span>
                  <span className="news-time dim small mono">{dateTime(n.publishedAt)}</span>
                  <span className={`news-sent ${n.sentimentLabel}`}>
                    {n.sentiment > 0 ? "+" : ""}
                    {n.sentiment.toFixed(2)}
                  </span>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </Panel>
  );
}