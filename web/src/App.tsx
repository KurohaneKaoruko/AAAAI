import { useCallback, useEffect, useState } from "react";
import { Sidebar, Toasts, TopBar } from "./components/Shell";
import { useAppStore } from "./state/useAppStore";
import { useTheme } from "./lib/theme";
import type { PageId } from "./components/Shell";
import { DashboardPage } from "./pages/DashboardPage";
import { BotsPage } from "./pages/BotsPage";
import { ExchangesPage } from "./pages/ExchangesPage";
import { StrategyPage } from "./pages/StrategyPage";
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
      case "exchanges":
        return <ExchangesPage store={store} />;
      case "strategy":
        return <StrategyPage store={store} />;
      case "risk":
        return <RiskPage store={store} />;
      case "llm":
        return <LlmPage store={store} />;
      case "compare":
        return <ComparePage store={store} />;
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