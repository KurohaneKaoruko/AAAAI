/**
 * K 线接口（/api/klines）：给前端实时 K 线图供数。
 *
 * 两条关键性质：
 * 1. 基本功能 —— 返回升序 Bar[]，timestamp 是 ISO 字符串，limit 被钳制；
 * 2. 模拟交易所走缓存实例 —— 图表上的价格必须与机器人脚下看到的是同一个世界
 *    （独立实例等于换一条随机路径，决策标记会对不上价格）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineController } from "../src/server/engineController.js";
import { ConnectionManager } from "../src/exchanges/connectionManager.js";
import { createServer } from "../src/server/httpServer.js";
import { WatchlistManager } from "../src/watchlist.js";
import { LlmManager } from "../src/llm/llmManager.js";
import { NewsService } from "../src/news/newsService.js";
import { EvolutionEngine } from "../src/evolution/engine.js";
import { StrategyStore } from "../src/strategies/profileStore.js";
import { BotManager } from "../src/bots/botManager.js";
import { AuthService } from "../src/auth/auth.js";
import { testConfig } from "./helpers.js";

/** 按 index.ts 的方式接线，好让 HTTP 路由跑的是真实链路（与 isolation.test.ts 同构）。 */
async function wire(dir: string) {
  const config = testConfig();
  const connections = new ConnectionManager(dir);
  const conn = connections.create({ adapterId: "testbed", label: "模拟" });
  const watchlist = new WatchlistManager(dir);
  const llm = new LlmManager(dir);
  const news = new NewsService(dir, config.news);
  const strategies = new StrategyStore(dir, { seed: { ...config.strategy, name: "默认策略" } });
  const evolution = new EvolutionEngine(dir, config, () => undefined);
  const bots = new BotManager(dir, config, connections, llm, strategies, evolution, news);
  const controller = new EngineController(config, connections, watchlist, llm, news, evolution, strategies, {
    list: () => bots.list(),
    strategyOf: (b) => bots.strategyOf(b),
  });
  const app = createServer(controller, {
    connections,
    watchlist,
    llm,
    bots,
    news,
    evolution,
    auth: new AuthService(mkdtempSync(join(tmpdir(), "aaaai-auth-"))),
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as { port: number }).port;
  return { connections, conn, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("klines：返回升序 ISO 字符串 K 线，OHLCV 齐全", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-klines-"));
  const w = await wire(dir);
  try {
    const res = await fetch(`http://localhost:${w.port}/api/klines?connectionId=${w.conn.id}&symbol=${encodeURIComponent("单边上行")}&interval=1h&limit=50`);
    assert.equal(res.status, 200, `应成功（实际 ${res.status}）`);
    const { bars } = (await res.json()) as { bars: { symbol: string; timestamp: string; open: number; high: number; low: number; close: number; volume: number }[] };
    assert.ok(Array.isArray(bars) && bars.length === 50, `应返回 50 根（实际 ${bars.length}）`);
    for (const b of bars) {
      assert.equal(typeof b.timestamp, "string");
      assert.ok(!Number.isNaN(new Date(b.timestamp).getTime()), "timestamp 必须是可解析的 ISO 字符串");
      assert.ok(b.high >= b.low, "high >= low");
      assert.ok(b.high >= Math.max(b.open, b.close), "high 覆盖实体");
      assert.ok(b.low <= Math.min(b.open, b.close), "low 覆盖实体");
    }
    const ts = bars.map((b) => new Date(b.timestamp).getTime());
    assert.deepEqual(ts, [...ts].sort((a, b) => a - b), "必须按时间升序");
  } finally {
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("klines：limit 钳制到 [10, 1000]，非法值落到默认", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-klines-"));
  const w = await wire(dir);
  try {
    const url = (limit: string): string =>
      `http://localhost:${w.port}/api/klines?connectionId=${w.conn.id}&symbol=${encodeURIComponent("单边上行")}&interval=1m&limit=${limit}`;
    const r1 = await fetch(url("5000"));
    assert.equal(((await r1.json()) as { bars: unknown[] }).bars.length, 1000, "上限钳到 1000");
    const r2 = await fetch(url("-3"));
    assert.equal(((await r2.json()) as { bars: unknown[] }).bars.length, 10, "下限钳到 10");
    const r3 = await fetch(url("abc"));
    assert.ok(((await r3.json()) as { bars: unknown[] }).bars.length >= 10, "非法值落默认（300），不抛 500");
  } finally {
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("klines：缺参数与不存在的连接报 4xx", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-klines-"));
  const w = await wire(dir);
  try {
    const noSym = await fetch(`http://localhost:${w.port}/api/klines?connectionId=${w.conn.id}&interval=1d`);
    assert.equal(noSym.status, 400, "缺 symbol 应 400");
    const badConn = await fetch(`http://localhost:${w.port}/api/klines?connectionId=不存在&symbol=单边上行&interval=1d`);
    assert.equal(badConn.status, 400, "连接不存在应 4xx（不是 500）");
  } finally {
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("klines：模拟交易所与机器人共用同一份行情（同连接取数逐字节一致）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-klines-"));
  const w = await wire(dir);
  try {
    const url = (limit: number): string =>
      `http://localhost:${w.port}/api/klines?connectionId=${w.conn.id}&symbol=${encodeURIComponent("单边上行")}&interval=1h&limit=${limit}`;
    const viaHttp = (await (await fetch(url(40))).json()) as { bars: { timestamp: string; close: number }[] };
    // 直接走连接上缓存的实例（机器人取价的同一个世界）
    const live = await w.connections.adapter(w.conn.id).fetchKlines("单边上行", "1h", 40);
    assert.equal(viaHttp.bars.length, live.length);
    for (let i = 0; i < live.length; i += 1) {
      const a = viaHttp.bars[i]!;
      const b = live[i]!;
      assert.equal(a.timestamp, b.timestamp.toISOString(), `第 ${i} 根时间应一致`);
      assert.equal(a.close, b.close, `第 ${i} 根收盘价应一致（独立实例会换路径，图表就与机器人对不上了）`);
    }
  } finally {
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
