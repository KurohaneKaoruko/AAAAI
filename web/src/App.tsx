import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, subscribeEvents } from "./api";
import type { Broadcast, EngineEventLine, EngineState } from "./types";
import { StatusBar } from "./components/StatusBar";
import { MetricsCards } from "./components/MetricsCards";
import { EquityChart } from "./components/EquityChart";
import { PositionsTable } from "./components/PositionsTable";
import { EventLog } from "./components/EventLog";
import { ControlPanel } from "./components/ControlPanel";
import { ConfigPanel } from "./components/ConfigPanel";

const MAX_EVENTS = 200;

export function App() {
  const [state, setState] = useState<EngineState | null>(null);
  const [events, setEvents] = useState<EngineEventLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const initialLoaded = useRef(false);

  useEffect(() => {
    let off: (() => void) | undefined;
    const boot = async () => {
      try {
        const initial = await api.state();
        setState(initial);
        setEvents(initial.events ?? []);
      } catch (err) {
        setError((err as Error).message);
      }
      off = subscribeEvents((b: Broadcast) => {
        if (b.type === "state") {
          setState(b.data);
        } else if (b.type === "event") {
          setEvents((prev) => [b.data, ...prev].slice(0, MAX_EVENTS));
        }
      });
    };
    void boot();
    return () => off?.();
  }, []);

  const handleStart = useCallback(async (mode: "backtest" | "live", symbol: string, bars: number) => {
    setError(null);
    try {
      await api.start(mode, { symbol: symbol || undefined, bars });
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const handleStop = useCallback(async () => {
    try {
      await api.stop();
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const handleSaveConfig = useCallback(async (patch: unknown) => {
    try {
      await api.saveConfig(patch);
      const next = await api.state();
      setState(next);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const running = state?.status === "running";
  const symbol = state?.symbol ?? state?.config?.market?.symbols?.[0] ?? "—";
  const initialCash = useMemo(
    () => state?.config?.risk?.initialCash ?? 0,
    [state?.config?.risk?.initialCash],
  );

  return (
    <div className="app">
      <StatusBar state={state} error={error} />
      <main className="grid">
        <section className="col col-left">
          <ControlPanel
            state={state}
            running={running}
            onStart={handleStart}
            onStop={handleStop}
          />
          <ConfigPanel
            config={state?.config ?? null}
            disabled={running}
            onSave={handleSaveConfig}
          />
        </section>
        <section className="col col-main">
          <MetricsCards state={state} initialCash={initialCash} symbol={symbol} />
          <EquityChart curve={state?.equityCurve ?? []} initialCash={initialCash} />
          <PositionsTable positions={state?.positions ?? []} prices={state?.prices ?? {}} />
        </section>
        <section className="col col-right">
          <EventLog events={events} />
        </section>
      </main>
      <footer className="footer">
        AAAAAI · Ai-Agent-Auto-Asset-Investment · 仅供学习研究，不构成投资建议
      </footer>
    </div>
  );
}
