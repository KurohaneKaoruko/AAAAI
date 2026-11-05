/**
 * 隔离：一次性历史运行（回测 / 对照）不得扰动实时机器人脚下的行情。
 *
 * 模拟交易所时代的事故形态是"情景种子长在适配器实例上，一次性运行把种子
 * 掷到了机器人正在用的那个实例上"。模拟交易所已下线（一切以实盘数据为准），
 * 但这条防线本身依然成立且必须锁住：ConnectionManager.independentAdapter()
 * 给一次性运行的是**独立实例**，缓存实例（= 实时机器人的世界）的状态
 * 不被碰——对真实交易所而言就是密钥缓存、内部限频计数器等可变状态。
 *
 * 这两条用例各锁一半：
 * 1. 回测 / 对照拿到的确实不是缓存实例（独立性的前提）；
 * 2. 跑完一次性运行后，缓存实例的取数结果与跑之前逐字节一致。
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

/** 按 index.ts 的方式接线，好让 HTTP 路由跑的是真实链路。 */
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
  return {
    connections,
    conn,
    controller,
    strategies,
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** 机器人取价用的就是连接上缓存的那个适配器实例（见 botManager 的 adapter 取值）。 */
function liveWorld(connections: ConnectionManager, connectionId: string) {
  return connections.adapter(connectionId);
}

test("隔离：回测用独立实例，不动实时机器人脚下的那份行情", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-isolation-"));
  const w = await wire(dir);
  try {
    const live = liveWorld(w.connections, w.conn.id);
    const before = await live.fetchKlines("单边上行", "1h", 40);

    // 独立实例必须真的独立：一次性运行拿到的不是缓存里那个
    const oneOff = w.connections.independentAdapter(w.conn.id);
    assert.notEqual(oneOff, live, "independentAdapter 必须给出与缓存不同的实例");

    const res = await fetch(`http://127.0.0.1:${w.port}/api/backtest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: w.conn.id,
        symbols: ["单边上行"],
        interval: "1h",
        barCount: 200,
        strategyId: w.strategies.default().id,
      }),
    });
    assert.equal(res.status, 200, `回测接口应成功（实际 ${res.status}）`);

    const after = await live.fetchKlines("单边上行", "1h", 40);
    assert.deepEqual(after, before, "回测不得改动实时机器人脚下的行情：机器人看到的必须还是同一份取数");
  } finally {
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("隔离：模拟对照用独立实例，同样不动实时机器人脚下的行情", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-isolation-"));
  const w = await wire(dir);
  try {
    const live = liveWorld(w.connections, w.conn.id);
    const before = await live.fetchKlines("单边上行", "1h", 40);

    const result = await w.controller.runSimulationComparison({
      keys: ["baseline"],
      symbols: ["单边上行"],
      interval: "1h",
      bars: 200,
    });
    assert.ok(result, "对照应产出结果");

    const after = await live.fetchKlines("单边上行", "1h", 40);
    assert.deepEqual(after, before, "对照不得改动实时机器人脚下的行情");
  } finally {
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
