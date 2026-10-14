/**
 * HTTP 服务：REST API + SSE 实时推送 + WebUI 静态托管。
 *
 * API 分组：
 * - /api/state、/api/config             引擎状态与配置
 * - /api/engine/start|stop              引擎控制
 * - /api/exchanges、/api/connections    交易所目录与连接管理
 * - /api/markets/search、/api/watchlist 标的搜索与自选
 */

import express, { type Express, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dump as dumpYaml } from "js-yaml";
import type { EngineController, StartOptions } from "./engineController.js";
import type { ConnectionManager } from "../exchanges/connectionManager.js";
import { listAdapterMetas } from "../exchanges/registry.js";
import { serializeConfig } from "../configSchema.js";
import { fromEnv } from "../config.js";
import { listAdapterMetas as _unused } from "../exchanges/registry.js";
import type { WatchlistManager } from "../watchlist.js";
import type { AuthService } from "../auth/auth.js";
import type { BalanceStrategy, LlmManager } from "../llm/llmManager.js";
import { STRATEGY_LABEL, SYSTEM_ONE_PRESETS, DEFAULT_LEVELS, DEFAULT_LEVEL_WEIGHTS, DEFAULT_INSTRUCTIONS } from "../llm/llmManager.js";
import { getLogger, logLines } from "../core/logger.js";

const log = getLogger("http");

export interface ServerOptions {
  connections: ConnectionManager;
  watchlist: WatchlistManager;
  llm: LlmManager;
  auth: AuthService;
  /** 配置文件路径，「保存到文件」时写回此处 */
  configPath?: string;
  webDist?: string;
}

export function createServer(controller: EngineController, options: ServerOptions): Express {
  const app = express();
  const { connections, watchlist, llm, auth, configPath } = options;
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
      controller.applyConfig(req.body ?? {});
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

  // ---------------- 引擎控制 ----------------

  app.post("/api/engine/start", (req, res) => {
    const body = (req.body ?? {}) as Partial<StartOptions>;
    const mode = body.mode === "live" ? "live" : "backtest";
    void controller
      .start({
        mode,
        symbols: Array.isArray(body.symbols) ? body.symbols : undefined,
        connectionId: body.connectionId,
        bars: typeof body.bars === "number" ? body.bars : undefined,
        interval: body.interval,
      })
      .then(() => ok(res, { state: controller.snapshot() }))
      .catch((err) => fail(res, err, 409));
  });

  /** 多模型并行模拟盘对照实验 */
  app.post("/api/bench/compare", (req, res) => {
    const body = (req.body ?? {}) as {
      symbols?: string[];
      bars?: number;
      interval?: string;
      runnerIds?: string[];
      includeBaseline?: boolean;
      kinds?: ("chat" | "systemone")[];
    };
    void controller
      .runModelComparison(body)
      .then((result) => ok(res, { result }))
      .catch((err) => fail(res, err, 409));
  });

  app.get("/api/bench/compare", (_req, res) => ok(res, { result: controller.snapshot().comparison }));

  app.post("/api/engine/stop", (_req, res) => {
    controller.stop();
    ok(res, { state: controller.snapshot() });
  });

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