/**
 * 隔离：一次性历史运行（回测 / 对照）不得扰动实时机器人脚下的行情。
 *
 * 背景：模拟交易所的情景种子长在适配器实例上，`newScenario()` 换掉的是
 * **整个价格世界**。回测与对照都拿"连接上缓存的那个适配器实例"去跑，
 * 而那个实例正是实时机器人轮询用的同一个 —— 于是点一次回测，机器人的
 * 行情就被换成另一条路：下一根 K 线看到的价格和上一根出现断层，凭空
 * 冒出一笔本不该有的成交。随机行情本身没问题，问题在于掷在了别人脚下。
 *
 * 这两条用例各锁一半：
 * 1. 回测 / 对照确实掷了一条新路径（否则"每次新路径"是假的）；
 * 2. 这条新路径只落在一次性运行的独立实例上，缓存实例（= 机器人的世界）逐字节没变。
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
import { AuthService, loadAuthConfig } from "../src/auth/auth.js";
import { testConfig } from "./helpers.js";

/** 故意不等于测试锁定的默认种子（helpers.ts 里那个），否则"换路径"看不出来。 */
const SEED = 4242;

/** 按 index.ts 的方式接线，好让 HTTP 路由跑的是真实链路。 */
async function wire(dir: string) {
  const config = testConfig();
  const connections = new ConnectionManager(dir);
  const conn = connections.create({ adapterId: "simulated", label: "模拟" });
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
    auth: new AuthService(loadAuthConfig({})),
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

test("隔离：回测掷新路径，但不动实时机器人脚下的那份行情", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-isolation-"));
  const w = await wire(dir);
  try {
    const live = liveWorld(w.connections, w.conn.id);
    const before = await live.fetchKlines("仓位1", "1h", 40);

    const res = await fetch(`http://127.0.0.1:${w.port}/api/backtest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: w.conn.id,
        symbols: ["仓位1"],
        interval: "1h",
        barCount: 200,
        strategyId: w.strategies.default().id,
        scenarioSeed: SEED,
      }),
    });
    assert.equal(res.status, 200, `回测接口应成功（实际 ${res.status}）`);
    const { result } = (await res.json()) as { result: { scenarioSeed: number } };
    assert.equal(result.scenarioSeed, SEED, "回测必须真的用上了指定的随机情景（否则这条用例没测到东西）");

    const after = await live.fetchKlines("仓位1", "1h", 40);
    assert.deepEqual(after, before, "回测不得改动实时机器人脚下的行情：机器人看到的必须还是同一条路");

    // 另一边：一次性运行确实是另一条路，只是掷在了别人看不见的地方
    const oneOff = w.connections.independentAdapter(w.conn.id);
    oneOff.newScenario?.(SEED);
    const fresh = await oneOff.fetchKlines("仓位1", "1h", 40);
    assert.notDeepEqual(fresh, before, "一次性运行应掷出一条与实时不同的随机路径");
  } finally {
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("隔离：模拟对照掷新路径，同样不动实时机器人脚下的行情", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-isolation-"));
  const w = await wire(dir);
  try {
    const live = liveWorld(w.connections, w.conn.id);
    const before = await live.fetchKlines("仓位1", "1h", 40);

    const result = await w.controller.runSimulationComparison({
      keys: ["baseline"],
      symbols: ["仓位1"],
      interval: "1h",
      bars: 200,
      scenarioSeed: SEED,
    });
    assert.equal(result.scenarioSeed, SEED, "对照必须真的用上了指定的随机情景");

    const after = await live.fetchKlines("仓位1", "1h", 40);
    assert.deepEqual(after, before, "对照不得改动实时机器人脚下的行情");
  } finally {
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
