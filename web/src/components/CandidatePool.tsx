/**
 * 候选池：决定 AI/规则能在哪些资产里选。
 *
 * 它同时是「快速运行」和「AI 自主配置资产」的输入：
 * 引擎按候选池取行情，配置器把池子里的标的交给模型挑。
 * 每个机器人可在自己的表单里覆盖，不必改这里的全局清单。
 */

import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppStore } from "../state/useAppStore";
import type { PopularSymbol, SymbolInfo } from "../types";
import { AssetBadge } from "./Shell";
import { Button, Empty, Notice, Panel, TextField } from "./ui";
import { money, pct } from "../lib/format";

export function CandidatePool({ store }: { store: AppStore }) {
  const { connections, watchlist, state } = store;
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [popular, setPopular] = useState<PopularSymbol[]>([]);
  const [live, setLive] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SymbolInfo[]>([]);
  const [searching, setSearching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [manual, setManual] = useState<SymbolInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!connectionId && connections[0]) setConnectionId(connections[0].id);
  }, [connections, connectionId]);

  const refreshPopular = async (id: string) => {
    try {
      const d = await api.popular(id, 24);
      setPopular(d.symbols);
      setLive(d.live);
    } catch {
      setPopular([]);
    }
  };

  // 切换连接即拉取该交易所的可选标的
  useEffect(() => {
    if (!connectionId) return;
    let cancelled = false;
    setLoading(true);
    void refreshPopular(connectionId).finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  // 打开候选池取一次行情：不取的话，摆在"行情"位置上的是服务启动那一刻的价格，
  // 谁也看不出它有多旧（这里没有定时刷新，之后靠「刷新」按钮）。
  useEffect(() => {
    void api
      .refreshTickers()
      .then(() => store.reloadState())
      .catch(() => undefined);
  }, []);

  if (connections.length === 0) {
    return (
      <Panel title="候选池">
        <Empty>请先到「交易所连接」页添加一个连接，再回来挑选候选资产。</Empty>
      </Panel>
    );
  }

  const adapter = connections.find((c) => c.id === connectionId)?.adapter;
  // 没有标的、只有自带走向的交易所（模拟交易所）：没有"候选池"这回事 ——
  // 走向是它自己生成的，让人先配一套标的代码才能开跑，纯属多此一举。这里只把这件事说清楚。
  if (adapter?.builtinSymbols) {
    const slots = (adapter.defaultSymbols ?? []).map((s) => s.symbol);
    return (
      <Panel
        title="候选池"
        subtitle={`${adapter.name}：没有标的，只有自带的走向`}
        actions={
          <select
            className="inline-select"
            value={connectionId}
            onChange={(e) => {
              setConnectionId(e.target.value);
              setResults([]);
            }}
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        }
      >
        <Notice tone="info">
          <b>{adapter.name}</b> 没有标的：它自带 {slots.length} 条走向{slots.length > 0 ? `（${slots.join(" / ")}）` : ""}，
          形状在本地生成、噪声随机 —— 看的不是一个品种，是策略在不同行情下的盈利。
          这里没有要你配的东西，直接去机器 / 回测 / 对照页开跑就行。
          候选池只对<b>真实交易所</b>生效（那里才有「允许交易哪些标的」这回事）。
        </Notice>
        <div className="dim small" style={{ marginTop: 8 }}>
          这些走向跟任何真实市场无关，所以这里连行情也不列；
          结果里的持仓/成交会出现这些走向名 —— 那是本地生成的走势，不是真实标的。
        </div>
      </Panel>
    );
  }

  const isAdded = (symbol: string) =>
    watchlist.some((w) => w.connectionId === connectionId && w.symbol === symbol);

  const add = async (s: { symbol: string; name: string; assetClass: string; currency: string }) => {
    try {
      await api.addWatch({ ...s, assetClass: s.assetClass as "crypto" | "stock", connectionId });
      store.toast("success", `${s.symbol} 已加入候选池`);
      await store.reloadWatchlist();
      await refreshPopular(connectionId);
    } catch (err) {
      store.toast("error", (err as Error).message);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.removeWatch(id);
      await store.reloadWatchlist();
      await refreshPopular(connectionId);
    } catch (err) {
      store.toast("error", (err as Error).message);
    }
  };

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setNotice(null);
    try {
      const { symbols } = await api.search(connectionId, query.trim());
      setResults(symbols);
      if (symbols.length === 0) setNotice("未搜索到标的，可从上面的常用清单里选，或手动添加代码");
    } catch (err) {
      setNotice((err as Error).message);
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const available = popular.filter((p) => !p.inWatchlist);
  const poolOn = watchlist.filter((w) => w.connectionId === connectionId);
  // 候选池行情：按连接取。同一个代码在两个连接上都加了也能分得清（ticker 带 connectionId）。
  const quoteOf = new Map(
    (state?.tickers ?? []).filter((t) => t.connectionId === connectionId).map((t) => [t.symbol, t]),
  );
  const refreshQuotes = async () => {
    setRefreshing(true);
    try {
      await api.refreshTickers();
      await store.reloadState();
    } catch (err) {
      store.toast("error", (err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Panel
      title="候选池"
      subtitle={`${poolOn.length} 个标的 · 引擎按此取行情，AI 在池子里自己选`}
      actions={
        <select
          className="inline-select"
          value={connectionId}
          onChange={(e) => {
            setConnectionId(e.target.value);
            setResults([]);
          }}
        >
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      }
    >
      <div className="hint-line">
        {live === false
          ? "当前无法获取实时价格（可能是外网不可达），列表与选取仍可正常使用。"
          : "价格与涨跌幅来自交易所实时数据，点击卡片加入候选池。"}
      </div>

      {loading ? (
        <div className="loading-inline">正在获取 {adapter?.name} 的可选标的…</div>
      ) : available.length > 0 ? (
        <>
          <div className="symbol-picker-head">点击加入（{available.length} 个）</div>
          <div className="symbol-cards">
            {available.map((p) => (
              <button
                key={p.symbol}
                type="button"
                className="symbol-card"
                onClick={() => void add(p)}
                title={`加入候选池：${p.name}`}
              >
                <span className="symbol-card-code mono">{p.symbol}</span>
                <span className="symbol-card-name">{p.name}</span>
                <span className="symbol-card-meta">
                  <AssetBadge assetClass={p.assetClass} />
                  {p.price !== null ? (
                    <span className="mono">
                      {money(p.price, p.price > 100 ? 2 : 4)}
                      {p.changePct !== null && (
                        <span className={p.changePct >= 0 ? "up" : "down"}> {pct(p.changePct)}</span>
                      )}
                    </span>
                  ) : (
                    <span className="dim small">{p.currency}</span>
                  )}
                </span>
                <span className="symbol-card-add">+ 加入</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <Empty>
          该连接的常用标的已全部在池中
          {popular.length === 0 ? "（该交易所未提供常用清单）" : ""}，可用下方搜索添加更多
        </Empty>
      )}

      <div className="search-row" style={{ marginTop: 14 }}>
        <input
          value={query}
          placeholder={
            adapter?.id === "eastmoney"
              ? "输入代码或名称，如 600519 / 茅台"
              : adapter?.id === "stooq"
                ? "输入美股代码，如 AAPL / TSLA"
                : "输入交易对，如 BTC / ETHUSDT"
          }
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void search()}
        />
        <Button variant="primary" onClick={search} busy={searching}>
          搜索
        </Button>
      </div>
      {notice && <Notice tone="warn">{notice}</Notice>}
      {results.length > 0 && (
        <div className="search-results">
          {results.map((r) => (
            <div className="search-row-item" key={r.symbol}>
              <div>
                <div className="mono strong">{r.symbol}</div>
                <div className="dim small">{r.name}</div>
              </div>
              <AssetBadge assetClass={r.assetClass} />
              <div className="dim small">计价 {r.currency}</div>
              <Button small disabled={isAdded(r.symbol)} onClick={() => void add(r)}>
                {isAdded(r.symbol) ? "已在池中" : "加入"}
              </Button>
            </div>
          ))}
        </div>
      )}

      {poolOn.length > 0 && (
        <div className="chip-row" style={{ marginTop: 14 }}>
          {poolOn.map((w) => (
            <span key={w.id} className="symbol-chip symbol-on">
              {w.symbol}
              <button
                type="button"
                className="chip-x"
                title="移出候选池"
                onClick={() => void remove(w.id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {poolOn.length > 0 && (
        <div className="quote-block">
          <div className="quote-head">
            <span className="hint-line">池内行情（打开这一页时取一次，自己不会动）</span>
            <Button small onClick={() => void refreshQuotes()} busy={refreshing}>
              刷新
            </Button>
          </div>
          <div className="ticker-strip">
            {poolOn.map((w) => {
              const q = quoteOf.get(w.symbol);
              return (
                <span className="ticker-item" key={w.id}>
                  <span className="ticker-symbol" title={w.name}>
                    {w.symbol}
                  </span>
                  {q ? (
                    <>
                      <span className="ticker-price mono">
                        {money(q.price, q.price > 100 ? 2 : 4)}
                      </span>
                      {/* 正数也带 +：只靠颜色分涨跌，色弱的人看不出方向 */}
                      <span
                        className={`ticker-change mono ${q.changePct >= 0 ? "up" : "down"}`}
                      >
                        {q.changePct >= 0 ? "+" : ""}
                        {pct(q.changePct)}
                      </span>
                    </>
                  ) : (
                    <span className="ticker-nodata">没有取到报价</span>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <details className="manual-add">
        <summary>仍然找不到？手动添加代码</summary>
        <div className="grid-2">
          <TextField
            label="代码"
            value={manual?.symbol ?? ""}
            placeholder={adapter?.assetClass === "stock" ? "600519" : "BTCUSDT"}
            onChange={(v) =>
              setManual({
                symbol: v.toUpperCase().trim(),
                name: manual?.name ?? v.toUpperCase().trim(),
                assetClass: adapter?.assetClass === "stock" ? "stock" : "crypto",
                currency: adapter?.assetClass === "stock" ? "CNY" : "USDT",
                lotSize: 1,
                pricePrecision: 2,
                qtyPrecision: 6,
              })
            }
          />
          <TextField
            label="名称"
            value={manual?.name ?? ""}
            onChange={(v) => setManual((prev) => ({ ...(prev ?? emptySymbol()), name: v }))}
          />
        </div>
        <Button small disabled={!manual?.symbol} onClick={() => manual?.symbol && void add(manual)}>
          添加
        </Button>
      </details>
    </Panel>
  );
}

function emptySymbol(): SymbolInfo {
  return {
    symbol: "",
    name: "",
    assetClass: "crypto",
    currency: "USDT",
    lotSize: 1,
    pricePrecision: 2,
    qtyPrecision: 6,
  };
}