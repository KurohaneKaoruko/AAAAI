import { useCallback, useEffect, useState } from "react";
import { Sidebar, Toasts, TopBar } from "./components/Shell";
import { Tour } from "./components/Tour";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useAppStore } from "./state/useAppStore";
import { useTheme } from "./lib/theme";
import type { PageId } from "./components/Shell";
import { DashboardPage } from "./pages/DashboardPage";
import { BotsPage } from "./pages/BotsPage";
import { BotDetailPage } from "./pages/BotDetailPage";
import { BacktestPage } from "./pages/BacktestPage";
import { ExchangesPage } from "./pages/ExchangesPage";
import { StrategyPage, type StrategyTab } from "./pages/StrategyPage";
import { RiskPage } from "./pages/RiskPage";
import { LlmPage } from "./pages/LlmPage";
import { ComparePage } from "./pages/ComparePage";
import { SystemPage } from "./pages/SystemPage";
import { SettingsPage } from "./pages/SettingsPage";
import { LoginPage } from "./pages/LoginPage";
import { api } from "./api";

const PAGE_TITLES: Record<PageId, string> = {
  dashboard: "仪表盘",
  bots: "交易机器人",
  backtest: "历史模拟",
  exchanges: "交易所连接",
  strategy: "策略",
  llm: "模型管理",
  compare: "模拟对照",
  risk: "风控",
  system: "系统",
  settings: "设置",
};

const STRATEGY_TABS: readonly StrategyTab[] = ["strategy", "pool", "intel", "validate"];

interface RouteState {
  page: PageId;
  /** 机器人详情：/bots/<id> */
  botId: string | null;
  /** 策略页当前标签：/strategy/<tab> */
  strategyTab: StrategyTab;
}

/**
 * 读 URL 哈希。这样刷新能回到当前页，浏览器前进/后退也能用；
 * 以前页面只存在 React state 里，刷新必回仪表盘、后退直接离开应用。
 * 无法识别的地址一律回仪表盘，不白屏。
 */
function readRoute(): RouteState {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [pageSeg = "", sub = ""] = raw.split("/");
  // 只认 PAGE_TITLES 的自有键；直接用 in 会把 toString 之类原型属性也当成页面
  const page: PageId = Object.prototype.hasOwnProperty.call(PAGE_TITLES, pageSeg)
    ? (pageSeg as PageId)
    : "dashboard";
  if (page === "bots") {
    let botId: string | null = null;
    if (sub) {
      try {
        botId = decodeURIComponent(sub);
      } catch {
        botId = null;
      }
    }
    return { page, botId, strategyTab: "strategy" };
  }
  if (page === "strategy" && STRATEGY_TABS.includes(sub as StrategyTab)) {
    return { page, botId: null, strategyTab: sub as StrategyTab };
  }
  return { page, botId: null, strategyTab: "strategy" };
}

function toHash(route: RouteState): string {
  if (route.page === "bots" && route.botId) return `#/bots/${encodeURIComponent(route.botId)}`;
  if (route.page === "strategy") return `#/strategy/${route.strategyTab}`;
  return `#/${route.page}`;
}

export function App() {
  const store = useAppStore();
  const { theme, toggle } = useTheme();
  const [route, setRoute] = useState<RouteState>(readRoute);
  // 机器人详情是机器人页的子页：/bots/<id>；编辑状态是临时 UI，不必写进 URL
  const [botEditId, setBotEditId] = useState<string | null>(null);
  const [auth, setAuth] = useState<{
    required: boolean;
    username: string;
    ok: boolean;
  } | null>(null);
  // 使用指引：首访自动播；顶栏 ? 递增此 key 重播
  const [tourKey, setTourKey] = useState(0);
  /** 窄屏抽屉侧栏 */
  const [navOpen, setNavOpen] = useState(false);

  const checkAuth = useCallback(async () => {
    try {
      const s = await api.authStatus();
      setAuth({
        required: s.authRequired,
        username: s.username,
        ok: s.authenticated,
      });
    } catch {
      // 鉴权接口不可用时（例如旧版本服务端）直接放行
      setAuth({ required: false, username: "", ok: true });
    }
  }, []);

  /**
   * 统一导航：侧栏、页内跳转、使用指引共用。
   * 写入 hash 形成历史记录；进 bots 时默认清掉详情/编辑子页。
   */
  const navigate = useCallback(
    (
      p: PageId,
      opts?: { botId?: string; strategyTab?: StrategyTab; keepEdit?: boolean },
    ) => {
      if (!(p === "bots" && opts?.keepEdit)) setBotEditId(null);
      const next: RouteState = {
        page: p,
        botId: p === "bots" ? opts?.botId ?? null : null,
        strategyTab: p === "strategy" ? opts?.strategyTab ?? "strategy" : "strategy",
      };
      setRoute(next);
      setNavOpen(false);
      const hash = toHash(next);
      if (window.location.hash !== hash) window.location.hash = hash;
    },
    [],
  );

  // 浏览器前进/后退：哈希是唯一事实来源
  useEffect(() => {
    const onHash = () => {
      const next = readRoute();
      // 顺手把无法识别/缺省标签的地址规范化，避免地址栏停在一个打不开的地址
      const normalized = toHash(next);
      if (window.location.hash !== normalized) window.history.replaceState(null, "", normalized);
      setRoute((prev) =>
        prev.page === next.page && prev.botId === next.botId && prev.strategyTab === next.strategyTab ? prev : next,
      );
      setNavOpen(false);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // 保持地址栏与状态一致（首次进入、策略标签切换用 replace，不额外堆历史）
  useEffect(() => {
    const hash = toHash(route);
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  }, [route]);

  // 切页回到顶部 + 浏览器标签标题
  useEffect(() => {
    const title = route.page === "bots" && route.botId ? "机器人详情" : PAGE_TITLES[route.page];
    document.title = `${title} · AAAAI`;
    window.scrollTo(0, 0);
  }, [route.page, route.botId]);

  // 抽屉打开时 Esc 关闭
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  const changeStrategyTab = useCallback((tab: StrategyTab) => {
    setRoute((prev) =>
      prev.page === "strategy" && prev.strategyTab !== tab ? { ...prev, strategyTab: tab } : prev,
    );
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  const render = () => {
    switch (route.page) {
      case "dashboard":
        return <DashboardPage store={store} onNavigate={navigate} />;
      case "bots":
        return route.botId ? (
          <BotDetailPage
            botId={route.botId}
            store={store}
            onBack={() => navigate("bots")}
            onStart={(id) => void api.startBot(id).then(() => undefined)}
            onStop={(id) => void api.stopBot(id)}
            onEdit={(id) => {
              setBotEditId(id);
              navigate("bots", { keepEdit: true });
            }}
          />
        ) : (
          <BotsPage
            store={store}
            onOpenDetail={(id) => navigate("bots", { botId: id })}
            initialEditId={botEditId}
          />
        );
      case "backtest":
        return <BacktestPage />;
      case "exchanges":
        return <ExchangesPage store={store} />;
      case "strategy":
        return (
          <StrategyPage
            store={store}
            initialTab={route.strategyTab}
            onTabChange={changeStrategyTab}
          />
        );
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
                navigate("strategy", { strategyTab: "pool" });
                return;
              }
              navigate(target);
            }}
          />
        );
      case "system":
        return <SystemPage store={store} />;
      case "settings":
        return <SettingsPage />;
    }
  };

  /**
   * 登录成功：先确认会话已生效，再把首屏数据重拉一遍。
   *
   * 首屏那几个请求是在登录页挂载时就发出去的（当时还没 cookie），全部 401 被吞，
   * 于是 connections/adapters 停在空数组 ——「模拟对照」的连接下拉会一个选项都没有。
   * 只在登录成功后补这一次重拉，退出登录时不用清空（下次登录会再刷）。
   */
  const handleLoggedIn = useCallback(async () => {
    // 顺手清掉旧版存过 localStorage 的凭据残留：现在统一走会话 Cookie。
    window.localStorage.removeItem("aaaai.token");
    await checkAuth();
    await store.reloadAll();
  }, [checkAuth, store]);

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* 服务端会话可能已过期，照样清本地 */
    }
    window.localStorage.removeItem("aaaai.token");
    await checkAuth();
  }, [checkAuth]);

  if (auth?.required && !auth.ok) {
    return (
      <LoginPage
        username={auth.username}
        onSuccess={() => void handleLoggedIn()}
      />
    );
  }

  return (
    <div className="app">
      {navOpen && (
        <button
          type="button"
          className="nav-scrim"
          aria-label="关闭导航菜单"
          onClick={() => setNavOpen(false)}
        />
      )}
      <Sidebar
        page={route.page}
        onNavigate={navigate}
        connections={store.connections}
        connected={store.connected}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />
      <div className="app-main">
        <TopBar
          store={store}
          theme={theme}
          onToggleTheme={toggle}
          onMenu={() => setNavOpen((v) => !v)}
          navOpen={navOpen}
          username={auth?.required ? auth.username : undefined}
          onLogout={() => void handleLogout()}
          onTourRestart={() => setTourKey((k) => k + 1)}
        />
        <main className="content">
          <ErrorBoundary key={`${route.page}:${route.botId ?? ""}`}>{render()}</ErrorBoundary>
        </main>
      </div>
      <Toasts store={store} />
      {/* 鉴权状态未决（auth===null）时先不播：登录页背后跑指引没有意义 */}
      {auth && <Tour onNavigate={navigate} forceKey={tourKey} />}
    </div>
  );
}
