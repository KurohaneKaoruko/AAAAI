import { useCallback, useEffect, useState } from "react";
import { Sidebar, Toasts, TopBar } from "./components/Shell";
import { useAppStore } from "./state/useAppStore";
import { useTheme } from "./lib/theme";
import type { PageId } from "./components/Shell";
import { DashboardPage } from "./pages/DashboardPage";
import { BotsPage } from "./pages/BotsPage";
import { BacktestPage } from "./pages/BacktestPage";
import { ExchangesPage } from "./pages/ExchangesPage";
import { StrategyPage, type StrategyTab } from "./pages/StrategyPage";
import { RiskPage } from "./pages/RiskPage";
import { LlmPage } from "./pages/LlmPage";
import { ComparePage } from "./pages/ComparePage";
import { SystemPage } from "./pages/SystemPage";
import { LoginPage } from "./pages/LoginPage";
import { api } from "./api";

export function App() {
  const store = useAppStore();
  const { theme, toggle } = useTheme();
  const [page, setPage] = useState<PageId>("dashboard");
  // 候选池是策略页里的一个标签页：跨页跳转要能落到对应标签，否则"去候选池"只会打开策略页第一个标签
  const [strategyTab, setStrategyTab] = useState<StrategyTab>("strategy");
  const [auth, setAuth] = useState<{ required: boolean; username: string; ok: boolean } | null>(null);

  const checkAuth = useCallback(async () => {
    try {
      const s = await api.authStatus();
      setAuth({ required: s.authRequired, username: s.username, ok: s.authenticated });
    } catch {
      // 鉴权接口不可用时（例如旧版本服务端）直接放行
      setAuth({ required: false, username: "", ok: true });
    }
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  const render = () => {
    switch (page) {
      case "dashboard":
        return <DashboardPage store={store} onNavigate={setPage} />;
      case "bots":
        return <BotsPage store={store} />;
      case "backtest":
        return <BacktestPage />;
      case "exchanges":
        return <ExchangesPage store={store} />;
      case "strategy":
        return <StrategyPage store={store} initialTab={strategyTab} />;
      case "risk":
        return <RiskPage store={store} />;
      case "llm":
        return <LlmPage store={store} />;
      case "compare":
        return (
          <ComparePage
            store={store}
            onNavigate={(target) => {
              if (target === "pool") {
                setStrategyTab("pool");
                setPage("strategy");
                return;
              }
              setPage(target);
            }}
          />
        );
      case "system":
        return <SystemPage store={store} />;
    }
  };

  if (auth?.required && !auth.ok) {
    return <LoginPage username={auth.username} onSuccess={() => void checkAuth()} />;
  }

  return (
    <div className="app">
      <Sidebar page={page} onNavigate={setPage} connections={store.connections} />
      <div className="app-main">
        <TopBar store={store} theme={theme} onToggleTheme={toggle} />
        <main className="content">{render()}</main>
      </div>
      <Toasts store={store} />
    </div>
  );
}