/**
 * HTTP 服务：REST API + SSE 实时推送 + WebUI 静态托管。
 *
 * API 分组：
 * - /api/state、/api/config             引擎状态与配置
 * - /api/bots                          交易机器人（唯一的运行入口）
 * - /api/exchanges、/api/connections    交易所目录与连接管理
 * - /api/markets/search、/api/watchlist 标的搜索与自选
 */

import express, { type Express, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dump as dumpYaml } from "js-yaml";
import type { EngineController } from "./engineController.js";
import type { ConnectionManager } from "../exchanges/connectionManager.js";
import { listAdapterMetas } from "../exchanges/registry.js";
import { serializeConfig } from "../configSchema.js";
import { fromEnv } from "../config.js";
import { listAdapterMetas as _unused } from "../exchanges/registry.js";
import type { WatchlistManager } from "../watchlist.js";
import type { AuthService } from "../auth/auth.js";
import type { BotManager } from "../bots/botManager.js";
import { runBacktest } from "../backtest/runner.js";
import type { NewsService } from "../news/newsService.js";
import type { EvolutionEngine } from "../evolution/engine.js";
import type { BotInput } from "../bots/types.js";
import type { StrategyProfileInput } from "../strategies/profileStore.js";
import { robustness, walkForward } from "../validation/walkForward.js";
import type { BalanceStrategy, LlmManager } from "../llm/llmManager.js";
import { STRATEGY_LABEL, SYSTEM_ONE_PRESETS, DEFAULT_LEVELS, DEFAULT_LEVEL_WEIGHTS, DEFAULT_INSTRUCTIONS } from "../llm/llmManager.js";
import { getLogger, logLines } from "../core/logger.js";

const log = getLogger("http");

export interface ServerOptions {
  connections: ConnectionManager;
  watchlist: WatchlistManager;
  llm: LlmManager;
  bots: BotManager;
  news: NewsService;
  evolution: EvolutionEngine;
  auth: AuthService;
  /** 配置文件路径，「保存到文件」时写回此处 */
  configPath?: string;
  webDist?: string;
}

export function createServer(controller: EngineController, options: ServerOptions): Express {
  const app = express();
  const { connections, watchlist, llm, bots, news, evolution, auth, configPath } = options;
  app.use(express.json({ limit: "1mb" }));

  // 开发期跨域（Vite 5173 -> 本服务 8787）
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // 鉴权中间件（默认关闭；开启后保护所有 /api 请求）
  app.use(auth.middleware());

  // ---------- 鉴权接口（需在中间件后、但自身免鉴权） ----------
  app.get("/api/auth/status", (req, res) => {
    ok(res, {
      ...auth.publicConfig(),
      authenticated: auth.authenticate(req),
    });
  });

  app.post("/api/auth/login", (req, res) => {
    const body = (req.body ?? {}) as { username?: string; password?: string };
    const token = auth.login(String(body.username ?? ""), String(body.password ?? ""));
    if (!token) {
      res.status(401).json({ error: "用户名或口令不正确" });
      return;
    }
    auth.setSessionCookie(res, token);
    log.info("用户 %s 登录成功", String(body.username));
    ok(res, { ok: true });
  });

  app.post("/api/auth/logout", (_req, res) => {
    auth.clearSessionCookie(res);
    ok(res, { ok: true });
  });

  const ok = <T>(res: Response, data: T): void => {
    res.json(data);
  };
  const fail = (res: Response, err: unknown, code = 400): void => {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("请求失败: %s", message);
    res.status(code).json({ error: message });
  };

  // ---------------- 引擎状态 / 配置 ----------------

  app.get("/api/health", (_req, res) => ok(res, { ok: true, name: controller.getConfig().app.name }));

  // 运行日志（服务端环形缓冲）
  app.get("/api/logs", (req, res) => {
    const limit = Number(req.query.limit ?? 200);
    ok(res, { logs: logLines(Math.min(Math.max(limit, 1), 1000)) });
  });
  app.get("/api/state", (_req, res) => ok(res, controller.snapshot()));
  app.get("/api/config", (_req, res) => ok(res, { config: controller.snapshot().config }));

  app.post("/api/config", (req, res) => {
    try {
      const next = controller.applyConfig(req.body ?? {});
      // 机器人持有自己的配置副本：不同步的话，实盘判定会读到旧的执行方式
      // （表现为"明明切到真实下单了，机器人还是拒绝启动"）。
      bots.useConfig(next);
      ok(res, { config: controller.snapshot().config });
    } catch (err) {
      fail(res, err);
    }
  });

  // 配置持久化：写回 YAML 文件（不含任何密钥）
  app.post("/api/config/persist", (_req, res) => {
    if (!configPath) {
      res.status(400).json({ error: "未指定配置文件路径（AAAAI_CONFIG）" });
      return;
    }
    try {
      const text = dumpYaml(serializeConfig(controller.getConfig()), { lineWidth: 100, noRefs: true });
      writeFileSync(configPath, text, "utf8");
      ok(res, { saved: configPath });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------- LLM 多实例管理 ----------

  app.get("/api/llm/profiles", (_req, res) =>
    ok(res, {
      profiles: llm.list(),
      overview: llm.overview(),
      pools: llm.poolCounts(),
      strategy: llm.getStrategy(),
      strategies: Object.entries(STRATEGY_LABEL).map(([value, label]) => ({ value, label })),
    }),
  );

  app.post("/api/llm/profiles", (req, res) => {
    try {
      ok(res, { profile: llm.create((req.body ?? {}) as never) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/llm/profiles/:id", (req, res) => {
    try {
      ok(res, { profile: llm.update(req.params.id, (req.body ?? {}) as never) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/llm/profiles/:id", (req, res) => {
    try {
      llm.remove(req.params.id);
      ok(res, { removed: req.params.id });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/llm/profiles/:id/test", (req, res) => {
    const prompt = String((req.body as { prompt?: string })?.prompt ?? "用一句话说明：你现在是交易助理。");
    void llm
      .testProfile(req.params.id, prompt)
      .then((r) => ok(res, r))
      .catch((err) => fail(res, err, 502));
  });

  app.post("/api/llm/profiles/:id/reset", (req, res) => {
    llm.resetStats(req.params.id);
    ok(res, { profiles: llm.list() });
  });

  /** 走真实负载均衡链路发一次请求（验证调度是否正常）。 */
  app.post("/api/llm/test", (req, res) => {
    const prompt = String((req.body as { prompt?: string })?.prompt ?? "用一句话说明：你现在是交易助理。");
    const started = Date.now();
    void llm
      .complete(prompt)
      .then((text) => ok(res, { ok: true, text, latencyMs: Date.now() - started }))
      .catch((err) => fail(res, err, 502));
  });

  /** 从环境变量导入密钥的可用变量名提示。 */
  app.get("/api/llm/env", (_req, res) =>
    ok(res, {
      apiKeyEnv: controller.getConfig().llm.apiKeyEnv,
      present: Boolean(fromEnv(controller.getConfig().llm.apiKeyEnv)),
    }),
  );

  app.post("/api/tickers/refresh", (_req, res) => {
    void controller
      .refreshTickers()
      .then((t) => ok(res, { tickers: t }))
      .catch((err) => fail(res, err, 502));
  });

  // ---------------- 前推验证 / 稳健性 ----------------

  app.get("/api/validation/robustness", async (req, res) => {
    const symbolParam = String(req.query.symbols ?? "").split(",").filter(Boolean);
    const symbols = symbolParam.length > 0 ? symbolParam : controller.resolveRunTarget().symbols;
    if (symbols.length === 0) {
      res.status(400).json({ error: "请先在候选池里选好标的（或用 ?symbols=A,B 指定）" });
      return;
    }
    try {
      const target = controller.resolveRunTarget(undefined, symbols);
      const adapter = connections.adapter(target.connection.id);
      const interval = target.interval;
      const report = await robustness(controller.getConfig(), {
        adapter,
        symbols,
        interval,
      });
      ok(res, report);
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/validation/walk-forward", async (req, res) => {
    const symbolParam = String(req.query.symbols ?? "").split(",").filter(Boolean);
    const symbols = symbolParam.length > 0 ? symbolParam : controller.resolveRunTarget().symbols;
    if (symbols.length === 0) {
      res.status(400).json({ error: "请先在候选池里选好标的（或用 ?symbols=A,B 指定）" });
      return;
    }
    try {
      const target = controller.resolveRunTarget(undefined, symbols);
      const adapter = connections.adapter(target.connection.id);
      const interval = target.interval;
      const folds = Number(req.query.folds ?? 4);
      const foldBars = Number(req.query.foldBars ?? 120);
      ok(res, await walkForward(controller.getConfig(), {
        adapter,
        symbols,
        interval,
        folds: Number.isFinite(folds) ? folds : 4,
        foldBars: Number.isFinite(foldBars) ? foldBars : 120,
      }));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- 新闻情报 ----------------

  app.get("/api/news", (_req, res) => ok(res, { items: news.list(80), status: news.status() }));

  app.post("/api/news/refresh", async (req, res) => {
    const symbols = Array.isArray(req.body?.symbols) ? (req.body.symbols as string[]) : [];
    try {
      ok(res, await news.refresh(symbols));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- 自我进化 ----------------

  app.get("/api/evolution", (_req, res) => ok(res, evolution.view()));

  /** 手动评估一次（force=true 跳过样本数与冷却限制） */
  app.post("/api/evolution/evaluate", (req, res) => {
    const force = req.body?.force === true;
    ok(res, { applied: evolution.evaluate(force), view: evolution.view() });
  });

  app.post("/api/evolution/rollback", (_req, res) => {
    const entry = evolution.rollback();
    ok(res, { reverted: entry, view: evolution.view() });
  });

  // ---------------- 策略列表 ----------------

  app.get("/api/strategies", (_req, res) =>
    ok(res, { strategies: controller.strategyList(), defaultId: controller.defaultStrategyId() }),
  );

  app.post("/api/strategies", (req, res) => {
    try {
      ok(res, { strategy: controller.createStrategy((req.body ?? {}) as StrategyProfileInput) });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/strategies/duplicate/:id", (req, res) => {
    try {
      ok(res, { strategy: controller.duplicateStrategy(req.params.id) });
    } catch (e) {
      fail(res, e);
    }
  });

  app.put("/api/strategies/:id", (req, res) => {
    try {
      ok(res, { strategy: controller.updateStrategy(req.params.id, (req.body ?? {}) as Partial<StrategyProfileInput>) });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/strategies/:id/default", (_req, res) => {
    try {
      ok(res, { strategy: controller.setDefaultStrategy(_req.params.id) });
    } catch (e) {
      fail(res, e);
    }
  });

  app.delete("/api/strategies/:id", (req, res) => {
    try {
      controller.removeStrategy(req.params.id);
      ok(res, { removed: req.params.id });
    } catch (e) {
      fail(res, e);
    }
  });

  // ---------------- 交易机器人（多实例并行） ----------------

  app.get("/api/bots", (_req, res) => ok(res, { bots: bots.list() }));

  app.post("/api/bots", (req, res) => {
    try {
      ok(res, { bot: bots.create((req.body ?? {}) as BotInput) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/bots/:id", (req, res) => {
    try {
      ok(res, { bot: bots.update(req.params.id, (req.body ?? {}) as Partial<BotInput>) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/bots/:id", (req, res) => {
    try {
      bots.remove(req.params.id);
      ok(res, { removed: req.params.id });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/bots/:id/start", (req, res) => {
    void bots
      .start(req.params.id)
      .then((state) => ok(res, { state, bot: bots.list().find((b) => b.id === req.params.id) }))
      .catch((err) => fail(res, err, 409));
  });

  app.post("/api/bots/:id/stop", (req, res) => {
    bots.stop(req.params.id);
    ok(res, { state: bots.state(req.params.id) });
  });

  /** 一次启动全部（并行） */
  app.post("/api/bots/start-all", (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : undefined;
    void bots
      .startMany(ids ?? bots.list().filter((b) => b.enabled).map((b) => b.id))
      .then((states) => ok(res, { states, bots: bots.list() }))
      .catch((err) => fail(res, err, 409));
  });

  app.post("/api/bots/stop-all", (_req, res) => {
    bots.stopAll();
    ok(res, { bots: bots.list() });
  });

  // ---------------- 历史模拟（回测：跑一段历史，不属于任何机器人） ----------------

  /**
   * 一次性回测。与机器人的分工：
   * 机器人是实时实体（决策/成交/统计都来自实时行情）；
   * 这里专门回放历史来验证策略参数，成交当然一次性全出 —— 这就是它该做的事。
   */
  app.post("/api/backtest", async (req, res) => {
    const body = (req.body ?? {}) as {
      connectionId?: string;
      symbols?: string[];
      interval?: string;
      barCount?: number;
      strategyId?: string;
      initialCash?: number;
      maxDrawdownPct?: number;
      minTradeValue?: number;
      /** 复现用：随机情景种子（仅模拟交易所有效，不填 = 每次掷新路径） */
      scenarioSeed?: number;
    };
    if (!body.connectionId) return fail(res, new Error("缺少 connectionId"), 400);
    try {
      const profile = body.strategyId
        ? bots.strategyList().find((p) => p.id === body.strategyId)
        : undefined;
      if (!profile) return fail(res, new Error("策略不存在"), 400);
      // 没给标的就按该连接解析：自带标的的交易所（模拟交易所）本来就没有"选标的"这一步
      const symbols =
        Array.isArray(body.symbols) && body.symbols.length > 0
          ? body.symbols
          : controller.resolveRunTarget(body.connectionId).symbols;
      // 独立实例：回测会掷一条新的随机路径，不能掷到实时机器人正在用的那个实例上
      const adapter = controller.independentAdapter(body.connectionId);
      const result = await runBacktest(
        controller.getConfig(),
        adapter,
        profile,
        {
          symbols,
          interval: body.interval ?? "1d",
          barCount: Math.max(20, Math.min(1000, Math.floor(body.barCount ?? 200))),
          strategyId: profile.id,
          ...(body.initialCash !== undefined ? { initialCash: body.initialCash } : {}),
          ...(body.maxDrawdownPct !== undefined ? { maxDrawdownPct: body.maxDrawdownPct } : {}),
          ...(body.minTradeValue !== undefined ? { minTradeValue: body.minTradeValue } : {}),
          ...(parseScenarioSeed(body.scenarioSeed) !== undefined
            ? { scenarioSeed: parseScenarioSeed(body.scenarioSeed) }
            : {}),
        },
      );
      // 把行情连接名一并给出：让人知道这份结果的数据来自哪儿
      const conn = connections.get(body.connectionId);
      ok(res, { result: conn?.label ? { ...result, connectionLabel: conn.label } : result });
    } catch (err) {
      fail(res, err);
    }
  });

  /** 模拟对照的参赛者清单（机器人 / 策略 / 模型 / 基线，含不可用原因） */
  app.get("/api/bench/participants", (_req, res) => ok(res, { participants: controller.listParticipants() }));

  /**
 * 解析"复现用情景种子"。
 *
 * 随机数种子没有"大概对"，错一个字符就是另一条路，所以这里宁可不认：
 * 非法输入直接当没填（= 掷新路径），而不是悄悄用一个错的种子去跑，
 * 让用户以为在复现某次结果、其实跑的是完全不相干的一条路径。
 */
function parseScenarioSeed(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return undefined;
  return n >>> 0;
}

/** 模拟对照：勾选参赛者 -> 并行模拟盘 -> 战绩排名 */
  app.post("/api/bench/compare", (req, res) => {
    const body = (req.body ?? {}) as {
      /** 参赛者 key 列表 */
      keys?: string[];
      symbols?: string[];
      bars?: number;
      interval?: string;
      /** 复现用：随机情景种子（仅模拟交易所有效，不填 = 掷一条新路径） */
      scenarioSeed?: number;
    };
    void controller
      .runSimulationComparison({
        keys: body.keys ?? [],
        symbols: body.symbols,
        bars: typeof body.bars === "number" ? body.bars : undefined,
        interval: body.interval,
        ...(parseScenarioSeed(body.scenarioSeed) !== undefined
          ? { scenarioSeed: parseScenarioSeed(body.scenarioSeed) }
          : {}),
      })
      .then((result) => ok(res, { result }))
      .catch((err) => fail(res, err, 409));
  });

  app.get("/api/bench/compare", (_req, res) => ok(res, { result: controller.snapshot().comparison }));

  // ---------------- 交易所目录与连接 ----------------

  app.get("/api/exchanges", (_req, res) => ok(res, { adapters: listAdapterMetas() }));

  // System One 预设（前端表单用）
  app.get("/api/llm/presets", (_req, res) =>
    ok(res, {
      presets: Object.entries(SYSTEM_ONE_PRESETS).map(([id, p]) => ({ id, ...p })),
      levels: DEFAULT_LEVELS,
      levelWeights: DEFAULT_LEVEL_WEIGHTS,
      instructions: DEFAULT_INSTRUCTIONS,
    }),
  );

  app.get("/api/connections", (_req, res) => ok(res, { connections: connections.list() }));

  app.post("/api/connections", (req, res) => {
    try {
      ok(res, { connection: connections.create(req.body ?? {}) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/connections/:id", (req, res) => {
    try {
      ok(res, { connection: connections.update(req.params.id, req.body ?? {}) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/connections/:id", (req, res) => {
    try {
      connections.remove(req.params.id);
      ok(res, { removed: req.params.id });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/connections/:id/test", (req, res) => {
    void connections
      .test(req.params.id)
      .then((result) => ok(res, result))
      .catch((err) => fail(res, err, 502));
  });

  // ---------------- 标的搜索与自选 ----------------

  /**
   * 常用标的一键选取：无需输入关键词。
   * 先取适配器内置清单，再尽力补上实时价格（外网不可达时只返回清单，不报错）。
   */
  app.get("/api/markets/popular", (req: Request, res: Response) => {
    const connectionId = String(req.query.connectionId ?? "");
    const limit = Math.min(Math.max(Number(req.query.limit ?? 12), 1), 60);
    let adapter;
    try {
      adapter = connections.adapter(connectionId);
    } catch (err) {
      fail(res, err);
      return;
    }

    const list = (adapter.meta.defaultSymbols ?? []).slice(0, limit);
    const inWatchlist = new Set(
      watchlist
        .list()
        .filter((w) => w.connectionId === connectionId)
        .map((w) => w.symbol),
    );

    void adapter
      .fetchTickers(list.map((x) => x.symbol))
      .then((tickers) => {
        const priceMap = new Map(tickers.map((t) => [t.symbol, t]));
        ok(res, {
          connectionId,
          source: adapter.meta.name,
          live: tickers.length > 0,
          symbols: list.map((item) => {
            const t = priceMap.get(item.symbol);
            return {
              ...item,
              inWatchlist: inWatchlist.has(item.symbol),
              price: t?.price ?? null,
              changePct: t?.changePct ?? null,
            };
          }),
        });
      })
      // 取不到实时价格不影响选取：清单照常返回
      .catch(() =>
        ok(res, {
          connectionId,
          source: adapter.meta.name,
          live: false,
          symbols: list.map((item) => ({ ...item, inWatchlist: inWatchlist.has(item.symbol), price: null, changePct: null })),
        }),
      );
  });

  app.get("/api/markets/search", (req: Request, res: Response) => {
    const q = String(req.query.q ?? "").trim();
    const connectionId = String(req.query.connectionId ?? "");
    if (!q) {
      ok(res, { symbols: [] });
      return;
    }
    try {
      const adapter = connections.adapter(connectionId);
      void adapter
        .searchSymbols(q, Number(req.query.limit ?? 20))
        .then((symbols) => ok(res, { symbols }))
        .catch((err) => fail(res, err, 502));
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/watchlist", (_req, res) => ok(res, { items: watchlist.list() }));

  app.post("/api/watchlist", (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        symbol: string;
        name: string;
        assetClass: "crypto" | "stock";
        currency: string;
        connectionId: string;
      };
      ok(res, { item: watchlist.add(body) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/watchlist/:id", (req, res) => {
    try {
      watchlist.remove(req.params.id);
      ok(res, { removed: req.params.id });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- SSE ----------------

  app.get("/api/events", (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (data: unknown): void => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    send({ type: "state", data: controller.snapshot() });
    const off = controller.onBroadcast((b) => send(b));
    const heartbeat = setInterval(() => res.write(": hb\n\n"), 15_000);
    req.on("close", () => {
      off();
      clearInterval(heartbeat);
    });
  });

  // ---------------- WebUI ----------------

  const webDist = options.webDist ? resolve(options.webDist) : null;
  if (webDist && existsSync(join(webDist, "index.html"))) {
    app.use(express.static(webDist));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(join(webDist, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => {
      res.json({
        name: "AAAAI API",
        hint: "WebUI 未构建。开发: npm run dev；生产: npm run build 后 npm start",
      });
    });
  }

  return app;
}