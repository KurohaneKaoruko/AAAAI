/** 引擎控制：模式、标的、周期、K线数、启动/停止。 */

import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppStore } from "../state/useAppStore";
import { Button, Notice, NumberField, SelectField } from "./ui";

export function RunControls({ store, compact = false }: { store: AppStore; compact?: boolean }) {
  const state = store.state;
  const connections = store.connections;
  const watchlist = store.watchlist;

  const [mode, setMode] = useState<"backtest" | "live">(state?.mode ?? "backtest");
  const [connectionId, setConnectionId] = useState(
    state?.connectionId ?? state?.config?.execution?.connectionId ?? connections[0]?.id ?? "",
  );
  const [symbols, setSymbols] = useState<string[]>(state?.symbols ?? []);
  const [interval, setInterval] = useState(state?.config?.market?.interval ?? "1m");
  const [bars, setBars] = useState(state?.config?.market?.barCount ?? 200);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connectionId && connections[0]) setConnectionId(connections[0].id);
  }, [connections, connectionId]);

  const adapter = connections.find((c) => c.id === connectionId)?.adapter;
  const intervals = adapter?.klineIntervals ?? ["1m", "5m", "15m", "1h", "4h", "1d"];
  const running = state?.status === "running";

  const watchSymbols = watchlist.filter((w) => w.connectionId === connectionId).map((w) => w.symbol);
  const effectiveSymbols = symbols.length > 0 ? symbols : watchSymbols;

  const toggle = (s: string) =>
    setSymbols((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.start({
        mode,
        connectionId,
        symbols: effectiveSymbols.length > 0 ? effectiveSymbols : undefined,
        bars: mode === "backtest" ? bars : undefined,
        interval,
      });
      store.toast("success", mode === "backtest" ? "回测完成" : "实时模式已启动");
      await store.reloadState();
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      store.toast("error", msg);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await api.stop();
      store.toast("info", "已停止");
      await store.reloadState();
    } catch (err) {
      store.toast("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`run-controls ${compact ? "run-controls-compact" : ""}`}>
      {!compact && (
        <div className="grid-2">
          <SelectField
            label="运行模式"
            value={mode}
            onChange={setMode}
            options={[
              { value: "backtest", label: "回测（跑历史 K 线）" },
              { value: "live", label: "实时（轮询新行情）" },
            ]}
          />
          <SelectField
            label="行情连接"
            value={connectionId}
            onChange={(v) => {
              setConnectionId(v);
              setSymbols([]);
            }}
            options={connections.map((c) => ({ value: c.id, label: c.label }))}
          />
        </div>
      )}

      <div className="grid-2">
        <SelectField
          label="K 线周期"
          value={interval}
          onChange={setInterval}
          options={intervals.map((i) => ({ value: i, label: i }))}
        />
        <NumberField
          label={mode === "live" ? "预热 K 线" : "回测 K 线"}
          value={bars}
          onChange={setBars}
          min={20}
          max={1000}
          step={20}
        />
      </div>

      <div className="symbol-picker">
        <div className="symbol-picker-head">
          运行标的
          {watchSymbols.length === 0 && <span className="dim"> · 请先到「策略 → 候选池」添加</span>}
        </div>
        {watchSymbols.length === 0 ? (
          <div className="dim small">
            暂无标的。可到「策略 → 候选池」搜索并添加后回到这里。
          </div>
        ) : (
          <div className="chip-row">
            {watchSymbols.map((s) => (
              <button
                key={s}
                type="button"
                className={`symbol-chip ${effectiveSymbols.includes(s) ? "symbol-on" : ""}`}
                onClick={() => toggle(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {!adapter?.supportsTrading && state?.config?.execution?.mode === "live" && (
        <Notice tone="warn">
          当前连接的交易所仅提供行情，无法真实下单；系统将自动降级为模拟成交。
        </Notice>
      )}

      <div className="btn-row">
        <Button variant="primary" onClick={start} disabled={running} busy={busy}>
          {running ? "运行中…" : mode === "backtest" ? "开始回测" : "启动实时"}
        </Button>
        <Button variant="danger" onClick={stop} disabled={!running}>
          停止
        </Button>
      </div>
    </div>
  );
}