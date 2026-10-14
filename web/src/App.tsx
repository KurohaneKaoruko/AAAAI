import { useState } from "react";
import { Sidebar, Toasts, TopBar } from "./components/Shell";
import { RunControls } from "./components/RunControls";
import { useAppStore } from "./state/useAppStore";
import { useTheme } from "./lib/theme";
import type { PageId } from "./components/Shell";
import { DashboardPage } from "./pages/DashboardPage";
import { MarketsPage } from "./pages/MarketsPage";
import { ExchangesPage } from "./pages/ExchangesPage";
import { StrategyPage } from "./pages/StrategyPage";
import { RiskPage } from "./pages/RiskPage";
import { LlmPage } from "./pages/LlmPage";
import { SystemPage } from "./pages/SystemPage";

export function App() {
  const store = useAppStore();
  const { theme, toggle } = useTheme();
  const [page, setPage] = useState<PageId>("dashboard");

  const render = () => {
    switch (page) {
      case "dashboard":
        return <DashboardPage store={store} />;
      case "markets":
        return <MarketsPage store={store} />;
      case "exchanges":
        return <ExchangesPage store={store} />;
      case "strategy":
        return <StrategyPage store={store} />;
      case "risk":
        return <RiskPage store={store} />;
      case "llm":
        return <LlmPage store={store} />;
      case "system":
        return <SystemPage store={store} />;
    }
  };

  return (
    <div className="app">
      <Sidebar page={page} onNavigate={setPage} connections={store.connections} />
      <div className="app-main">
        <TopBar store={store} actions={<RunControls store={store} compact />} theme={theme} onToggleTheme={toggle} />
        <main className="content">{render()}</main>
      </div>
      <Toasts store={store} />
    </div>
  );
}