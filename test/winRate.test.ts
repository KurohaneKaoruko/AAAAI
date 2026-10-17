/**
 * 多情景胜率：把「大部分场景盈利为正」变成一个可测量的数字。
 *
 * 锁的行为：
 * 1. 数字是真的 —— winRate/median/worst 全部能从 outcomes 逐条重算出来，
 *    不是字段里写个漂亮数；
 * 2. 可复现 —— 同一颗起始种子跑两遍，逐条结果一致（否则「复现这份报告」是假话）；
 * 3. 换种子 = 换一批路径（派生不是走个形式）；
 * 4. 掷路径只掷在独立实例上，实时机器人脚下的行情逐字节不变（与回测/对照同一条铁律）；
 * 5. 真实行情连接直接拒绝：真实历史只有一条，重复跑 N 次只会得到同一个数，
 *    那种「胜率」是假数字。
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
import { runWinRate, type WinRateReport } from "../src/validation/winRate.js";
import { testConfig, testAdapter } from "./helpers.js";

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

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

test("多情景胜率：汇总数字能从逐条结果重算出来（不是字段里写个漂亮数）", async () => {
  const adapter = testAdapter();
  const profile = {
    id: "t",
    name: "双均线",
    decisionSource: "rules",
    createdAt: "",
    updatedAt: "",
    fastWindow: 5,
    slowWindow: 20,
    maxTargetWeight: 0.5,
  } as Parameters<typeof runWinRate>[2];
  const report = await runWinRate(testConfig(), adapter, profile, ["单边上行"], {
    scenarios: 4,
    interval: "1m",
    barCount: 120,
    seed: 20261018,
  });
  assert.equal(report.outcomes.length, 4, "跑了几条路径就有几条结果");
  // 正收益率占比：期末权益 > 本金（用户口径里的「资金是原本的 100% 以上」）
  const wins = report.outcomes.filter((o) => o.returnPct > 0).length;
  assert.equal(report.winRate, wins / report.outcomes.length, "winRate 必须逐条重算得出");
  for (const o of report.outcomes) {
    assert.equal(o.positive, o.returnPct > 0, "positive 标记与 returnPct 同义");
  }
  assert.equal(report.medianReturn, median(report.outcomes.map((o) => o.returnPct)), "median 取中位");
  assert.equal(report.worstReturn, Math.min(...report.outcomes.map((o) => o.returnPct)), "worst 取最差");
  assert.equal(report.bestReturn, Math.max(...report.outcomes.map((o) => o.returnPct)), "best 取最好");
  // 单走向运行有分走向归因
  assert.equal(report.byRegime.length, 1);
  assert.equal(report.byRegime[0]!.regime, "单边上行");
  assert.equal(report.byRegime[0]!.positiveRuns, wins);
});

test("多情景胜率：同一颗起始种子，两份报告逐条一致（可复现）", async () => {
  const profile = {
    id: "t",
    name: "双均线",
    decisionSource: "rules",
    createdAt: "",
    updatedAt: "",
    fastWindow: 5,
    slowWindow: 20,
    maxTargetWeight: 0.5,
  } as Parameters<typeof runWinRate>[2];
  const opts = { scenarios: 3, interval: "1m", barCount: 100, seed: 777 } as const;
  const a = await runWinRate(testConfig(), testAdapter(), profile, ["震荡整理"], opts);
  const b = await runWinRate(testConfig(), testAdapter(), profile, ["震荡整理"], opts);
  assert.deepEqual(
    a.outcomes.map((o) => [o.seed, o.returnPct]),
    b.outcomes.map((o) => [o.seed, o.returnPct]),
    "同一起始种子必须给出同一批路径与结果，否则「复现这份报告」是假话",
  );
  // 起始种子不同 → 路径必须不同（派生不是走形式）
  const c = await runWinRate(testConfig(), testAdapter(), profile, ["震荡整理"], { ...opts, seed: 778 });
  assert.notDeepEqual(
    a.outcomes.map((o) => o.seed),
    c.outcomes.map((o) => o.seed),
    "换起始种子应换一批路径",
  );
});

test("多情景胜率：非模拟连接直接拒绝（真实行情给不出「不同场景」）", async () => {
  const fake = { meta: { id: "stooq" } } as unknown as Parameters<typeof runWinRate>[1];
  const profile = { id: "t", name: "x", decisionSource: "rules" } as Parameters<typeof runWinRate>[2];
  await assert.rejects(
    () => runWinRate(testConfig(), fake, profile, ["AAPL"], {}),
    /只在模拟交易所/,
    "拒绝文案要说清原因，而不是静默给出一个假胜率",
  );
});

test("多情景胜率：HTTP 路由掷路径不动实时机器人脚下的行情", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-winrate-"));
  const w = await wire(dir);
  try {
    const live = w.connections.adapter(w.conn.id);
    const before = await live.fetchKlines("单边上行", "1h", 40);

    const res = await fetch(`http://127.0.0.1:${w.port}/api/validation/win-rate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: w.conn.id,
        strategyId: w.strategies.default().id,
        symbols: ["单边上行"],
        interval: "1h",
        barCount: 80,
        scenarios: 3,
        seed: 4242,
      }),
    });
    assert.equal(res.status, 200, `胜率接口应成功（实际 ${res.status}）`);
    const report = (await res.json()) as WinRateReport;
    assert.equal(report.outcomes.length, 3, "应跑 3 条路径");
    assert.ok(report.winRate >= 0 && report.winRate <= 1);

    const after = await live.fetchKlines("单边上行", "1h", 40);
    assert.deepEqual(after, before, "胜率评估掷的路径只落在独立实例上，实时行情逐字节不变");

    // 策略不存在 → 400，别悄悄换一个策略跑
    const bad = await fetch(`http://127.0.0.1:${w.port}/api/validation/win-rate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: w.conn.id, strategyId: "nope", scenarios: 2 }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
