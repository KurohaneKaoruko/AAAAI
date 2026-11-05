/**
 * 连接标的管理（候选池）：决定 AI/规则能在哪些资产里选。
 *
 * 使用位置：交易所连接页里，每个连接卡片下方内嵌一份（见 ExchangesPage）——
 * 「这个连接交易哪些标的」就地管理，不用再去单独的设置页找。
 * 它同时是「快速运行」和「AI 自主配置资产」的输入：
 * 引擎按候选池取行情，配置器把池子里的标的交给模型挑。
 */

import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppStore } from "../state/useAppStore";
import type { PopularSymbol, SymbolInfo } from "../types";
import { AssetBadge } from "./Shell";
import { Button, Empty, Notice, TextField } from "./ui";
import { money, signedPct } from "../lib/format";

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

/**
 * 单连接的标的管理区块。
 * props.connectionId 固定为所属连接 —— 组件内不再提供连接切换（切换 = 去看另一张卡片）。
 */
export function ConnectionSymbols({ store, connectionId }: { store: AppStore; connectionId: string }) {
  const { connections, watchlist, state } = store;
  const connection = connections.find((c) => c.id === connectionId);
  const adapter = connection?.adapter;
  const [popular, setPopular] = useState<PopularSymbol[]>([]);
  const [live, setLive] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SymbolInfo[]>([]);
  const [searching, setSearching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [manual, setManual] = useState<SymbolInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refreshPopular = async (id: string) => {
    try {
      const d = await api.popular(id, 24);
      setPopular(d.symbols);
      setLive(d.live);
    } catch {
      setPopular([]);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void refreshPopular(connectionId).finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  // 打开时取一次行情：不取的话，摆在"行情"位置上的是服务启动那一刻的价格。
  useEffect(() => {
    void api
      .refreshTickers()
      .then(() => store.reloadState())
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!connection || !adapter) return null;

  // 没有标的、只有自带走向的交易所（模拟交易所）：没有"候选池"这回事 ——
  // 走向是它自己生成的，让人先配一套标的代码才能开跑，纯属多此一举。这里只把这件事说清楚。
  if (adapter.builtinSymbols) {
    const slots = (adapter.defaultSymbols ?? []).map((s) => s.symbol);
    return (
      <details className="conn-symbols">
        <summary>
          标的 <span className="page-tab-count">{slots.length}</span>
          <span className="dim small">该连接自带走向，本地生成、无需配置</span>
        </summary>
        <div className="conn-symbols-body">
          <div className="dim small">
            {adapter.name} 没有标的，只有自带的 {slots.length} 条走向
            {slots.length > 0 ? `（${slots.join(" / ")}）` : ""}。
            看的不是一个品种，是策略在不同行情下的盈利；直接去「交易机器人」/「回测」/「对照实验」页开跑即可。
          </div>
        </div>
      </details>
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
    <details className="conn-symbols">
      <summary>
        标的 <span className="page-tab-count">{poolOn.length}</span>
        <span className="dim small">引擎按此取行情，AI 在池子里自己选</span>
      </summary>
      <div className="conn-symbols-body">
      <div className="conn-symbols-head">
        {poolOn.length > 0 && (
          <Button small onClick={() => void refreshQuotes()} busy={refreshing}>
            刷新行情
          </Button>
        )}
      </div>

      {poolOn.length > 0 && (
        <div className="chip-row" style={{ marginBottom: 10 }}>
          {poolOn.map((w) => {
            const q = quoteOf.get(w.symbol);
            return (
              <span key={w.id} className="symbol-chip symbol-on" title={q ? `${money(q.price, q.price > 100 ? 2 : 4)} ${signedPct(q.changePct)}` : w.name}>
                {w.symbol}
                {q && <span className={`mono ${q.changePct >= 0 ? "up" : "down"}`}>{signedPct(q.changePct)}</span>}
                <button
                  type="button"
                  className="chip-x"
                  title="移出候选池"
                  onClick={() => void remove(w.id)}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}

      <div className="hint-line">
        {live === false
          ? "当前无法获取实时价格（可能是外网不可达），列表与选取仍可正常使用。"
          : "价格与涨跌幅来自交易所实时数据，点击卡片加入候选池。"}
      </div>

      {loading ? (
        <div className="loading-inline">正在获取 {adapter.name} 的可选标的…</div>
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
                <span className="symbol-card-extra">
                  {p.price !== null ? (
                    <span className="mono">
                      {money(p.price, p.price > 100 ? 2 : 4)}
                      {p.changePct !== null && (
                        <span className={p.changePct >= 0 ? "up" : "down"}> {signedPct(p.changePct)}</span>
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
      ) : popular.length === 0 ? (
        <Empty>该交易所没有提供常用标的清单，可用下方搜索或「手动添加代码」加入。</Empty>
      ) : (
        <Empty>常用标的都已加入候选池，可用下方搜索添加更多。</Empty>
      )}

      <div className="search-row" style={{ marginTop: 12 }}>
        <input
          value={query}
          placeholder={
            adapter.id === "stooq"
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
              {isAdded(r.symbol) ? (
                <span className="chip chip-sm chip-ok">已在池中</span>
              ) : (
                <Button small onClick={() => void add(r)}>
                  加入
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <details className="manual-add">
        <summary>仍然找不到？手动添加代码</summary>
        <div className="grid-2">
          <TextField
            label="代码"
            value={manual?.symbol ?? ""}
            placeholder={adapter.assetClass === "stock" ? "AAPL" : "BTCUSDT"}
            onChange={(v) =>
              setManual({
                symbol: v.toUpperCase().trim(),
                name: manual?.name ?? v.toUpperCase().trim(),
                assetClass: adapter.assetClass === "stock" ? "stock" : "crypto",
                currency: adapter.assetClass === "stock" ? "CNY" : "USDT",
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
        <div className="btn-row" style={{ marginTop: 8 }}>
          <Button
            small
            variant="primary"
            disabled={!manual?.symbol}
            onClick={() => {
              if (manual?.symbol) void add(manual);
            }}
          >
            手动加入
          </Button>
        </div>
      </details>
      </div>
    </details>
  );
}
