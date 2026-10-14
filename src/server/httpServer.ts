/** HTTP 服务：REST API + SSE 实时推送 + WebUI 静态托管。 */

import express, { type Express, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EngineController, EngineMode } from "./engineController.js";

export interface ServerOptions {
  webDist?: string;
}

export function createServer(controller: EngineController, options: ServerOptions = {}): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // 开发期跨域（Vite dev server 5173 -> 本服务 8787）
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // ---- REST ----

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, name: controller.getConfig().app.name });
  });

  app.get("/api/state", (_req, res) => {
    res.json(controller.snapshot());
  });

  app.get("/api/config", (_req, res) => {
    res.json({ config: controller.snapshot().config });
  });

  app.post("/api/config", (req, res) => {
    try {
      const patch = req.body ?? {};
      controller.applyConfig(patch);
      res.json({ ok: true, config: controller.snapshot().config });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post("/api/engine/start", (req, res) => {
    void (async () => {
      try {
        const mode = (req.body?.mode ?? "backtest") as EngineMode;
        if (mode !== "backtest" && mode !== "live") {
          res.status(400).json({ ok: false, error: `未知模式: ${mode}` });
          return;
        }
        await controller.start(mode, {
          symbol: req.body?.symbol,
          bars: req.body?.bars,
        });
        res.json({ ok: true, state: controller.snapshot() });
      } catch (err) {
        res.status(409).json({ ok: false, error: (err as Error).message });
      }
    })();
  });

  app.post("/api/engine/stop", (_req, res) => {
    controller.stop();
    res.json({ ok: true, state: controller.snapshot() });
  });

  // ---- SSE：引擎状态 + 事件流 ----

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

  // ---- WebUI 静态资源（生产构建后） ----

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
        endpoints: ["/api/health", "/api/state", "/api/config", "/api/events", "/api/engine/start", "/api/engine/stop"],
      });
    });
  }

  return app;
}
