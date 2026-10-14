import { useState } from "react";
import type { EngineState } from "../types";

export function ControlPanel({
  state,
  running,
  onStart,
  onStop,
}: {
  state: EngineState | null;
  running: boolean;
  onStart: (mode: "backtest" | "live", symbol: string, bars: number) => void;
  onStop: () => void;
}) {
  const [mode, setMode] = useState<"backtest" | "live">("backtest");
  const [symbol, setSymbol] = useState(state?.symbol ?? state?.config?.market?.symbols?.[0] ?? "BTCUSDT");
  const [bars, setBars] = useState(state?.config?.market?.barCount ?? 200);

  return (
    <div className="panel">
      <div className="panel-title">引擎控制</div>
      <div className="form">
        <label className="field">
          <span>模式</span>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as "backtest" | "live")}
            disabled={running}
          >
            <option value="backtest">回测（一次性）</option>
            <option value="live">实时（轮询行情）</option>
          </select>
        </label>
        <label className="field">
          <span>标的</span>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            disabled={running}
            placeholder="BTCUSDT"
          />
        </label>
        <label className="field">
          <span>K 线数量{state?.config?.market?.source === "binance" ? "（预热）" : ""}</span>
          <input
            type="number"
            min={2}
            max={1000}
            value={bars}
            onChange={(e) => setBars(Number(e.target.value))}
            disabled={running || mode === "live"}
          />
        </label>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onStart(mode, symbol, bars)}
            disabled={running}
          >
            {running ? "运行中…" : mode === "live" ? "启动实时" : "启动回测"}
          </button>
          <button type="button" className="btn" onClick={onStop} disabled={!running}>
            停止
          </button>
        </div>
        {state?.error && <div className="form-error">{state.error}</div>}
        {mode === "live" && state?.config?.market?.source === "stub" && (
          <div className="form-hint">当前数据源为 stub，实时模式将按本地时间推进假数据。</div>
        )}
      </div>
    </div>
  );
}
