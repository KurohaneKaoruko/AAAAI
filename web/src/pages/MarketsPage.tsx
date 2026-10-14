/** 自选标的：跨交易所搜索 + 自选列表管理。 */

import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppStore } from "../state/useAppStore";
import type { SymbolInfo } from "../types";
import { AssetBadge } from "../components/Shell";
import { Button, Empty, Notice, Panel, TextField } from "../components/ui";
import { money, pct, qty } from "../lib/format";

export function MarketsPage({ store }: { store: AppStore }) {
  const { connections, watchlist, state } = store;
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SymbolInfo[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState<SymbolInfo | null>(null);

  useEffect(() => {
    if (!connectionId && connections[0]) setConnectionId(connections[0].id);
  }, [connections, connectionId]);

  if (connections.length === 0) {
    return (
      <Panel title="自选标的">
        <Empty>请先到「交易所连接」页添加一个连接，再回来添加标的。</Empty>
      </Panel>
    );
  }

  const adapter = connections.find((c) => c.id === connectionId)?.adapter;
  const tickerOf = (symbol: string) => state?.tickers?.find((t) => t.symbol === symbol);

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const { symbols } = await api.search(connectionId, query.trim());
      setResults(symbols);
      if (symbols.length === 0) setError("未搜索到标的，可试试其他关键词，或用下方「手动添加」直接填代码");
    } catch (err) {
      setError((err as Error).message);
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const add = async (s: SymbolInfo) => {
    try {
      await api.addWatch({
        symbol: s.symbol,
        name: s.name,
        assetClass: s.assetClass,
        currency: s.currency,
        connectionId,
      });
      store.toast("success", `${s.symbol} 已加入自选`);
      await store.reloadWatchlist();
    } catch (err) {
      store.toast("error", (err as Error).message);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.removeWatch(id);
      await store.reloadWatchlist();
    } catch (err) {
      store.toast("error", (err as Error).message);
    }
  };

  return (
    <div className="page page-markets">
      <Panel
        title="搜索标的"
        subtitle={adapter ? `数据源：${adapter.name}` : ""}
      >
        <div className="search-row">
          <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <input
            value={query}
            placeholder={
              adapter?.id === "eastmoney" ? "输入代码或名称，如 600519 / 茅台" :
              adapter?.id === "stooq" ? "输入美股代码，如 AAPL / TSLA" :
              adapter?.id === "simulated" ? "输入 DEMO-BTC" :
              "输入交易对，如 BTC / ETHUSDT"
            }
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void search()}
          />
          <Button variant="primary" onClick={search} busy={searching}>
            搜索
          </Button>
        </div>
        {adapter && (
          <div className="hint-line">
            {adapter.description}
          </div>
        )}
        {error && <Notice tone="warn">{error}</Notice>}

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
                <Button small onClick={() => void add(r)}>
                  加入自选
                </Button>
              </div>
            ))}
          </div>
        )}

        <details className="manual-add">
          <summary>搜索不到？手动添加代码</summary>
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
          <Button
            small
            disabled={!manual?.symbol}
            onClick={() => manual?.symbol && void add(manual)}
          >
            添加
          </Button>
        </details>
      </Panel>

      <Panel title="我的自选" subtitle={`${watchlist.length} 个标的`}>
        {watchlist.length === 0 ? (
          <Empty>还没有自选标的，先在上面搜索添加吧</Empty>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>代码</th>
                  <th>名称</th>
                  <th>类别</th>
                  <th>连接</th>
                  <th className="num">现价</th>
                  <th className="num">涨跌</th>
                  <th className="num">最小单位</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {watchlist.map((w) => {
                  const t = tickerOf(w.symbol);
                  const conn = connections.find((c) => c.id === w.connectionId);
                  return (
                    <tr key={w.id}>
                      <td className="mono strong">{w.symbol}</td>
                      <td>{w.name}</td>
                      <td><AssetBadge assetClass={w.assetClass} /></td>
                      <td className="dim small">{conn?.label ?? w.connectionId}</td>
                      <td className="mono num">{t ? money(t.price, t.price > 100 ? 2 : 4) : "—"}</td>
                      <td className={`mono num ${(t?.changePct ?? 0) >= 0 ? "up" : "down"}`}>
                        {t ? pct(t.changePct) : "—"}
                      </td>
                      <td className="mono num dim">{qty(w.assetClass === "stock" ? 1 : 0.001, 3)}</td>
                      <td className="num">
                        <Button small variant="ghost" onClick={() => void remove(w.id)}>
                          移除
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
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