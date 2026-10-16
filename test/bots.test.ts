/** 交易机器人：多个自动化交易并行、互不干扰，各自独立配置模型与策略。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotManager } from "../src/bots/botManager.js";
// 与 botManager 的上限保持一致：测试要断言"截断到这么多笔"，两边必须同源
const HISTORY_TRADES_PER_RUN = 60;
import { EvolutionEngine } from "../src/evolution/engine.js";
import { StrategyStore } from "../src/strategies/profileStore.js";
import { ConnectionManager } from "../src/exchanges/connectionManager.js";
import { LlmManager } from "../src/llm/llmManager.js";
import { testConfig } from "./helpers.js";

function setup(): { dir: string; bots: BotManager; connectionId: string } {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-bots-"));
  const connections = new ConnectionManager(dir);
  const conn = connections.create({ adapterId: "simulated", label: "模拟盘" });
  const llm = new LlmManager(dir);
  const bots = new BotManager(dir, testConfig(), connections, llm);
  return { dir, bots, connectionId: conn.id };
}

/**
 * 等条件成立。实时机器人的成交来自轮询 tick，测试必须等 tick，
 * 不能再假设"启动即跑完"（那是回测语义，已移出机器人）。
 */
async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("等待条件超时");
    await new Promise((r) => setTimeout(r, 40));
  }
}

test("机器人：可创建多个，各自保存独立配置", () => {
  const { dir, bots, connectionId } = setup();
  try {
    const a = bots.create({ name: "BTC 趋势", connectionId, symbols: ["DEMO-BTC"] });
    const b = bots.create({
      name: "A股均线",
      connectionId,
      symbols: ["600519"],
      decisionSource: "chat",
      strategy: { fastWindow: 3, slowWindow: 9, maxTargetWeight: 0.9 },
      risk: { initialCash: 5000, minTradeValue: 800 },
    });
    assert.notEqual(a.id, b.id);
    assert.equal(bots.list().length, 2);

    // 改一个不影响另一个
    bots.update(b.id, { name: "A股改" });
    assert.equal(bots.get(a.id)!.name, "BTC 趋势");
    assert.equal(bots.get(b.id)!.name, "A股改");
    assert.equal(bots.get(b.id)!.strategy.slowWindow, 9);
    assert.equal(bots.get(b.id)!.risk.initialCash, 5000);
    // 量化交易（纯规则）机器人标注清楚
    assert.deepEqual(bots.list()[0]!.modelLabels, ["双均线动量（量化交易）"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("机器人：并行运行，资金与成交各自独立", async () => {
  const { dir, bots, connectionId } = setup();
  try {
    const a = bots.create({
      name: "A",
      connectionId,
      symbols: ["600519"],
      pollMs: 120,
      barCount: 60,
      risk: { initialCash: 100_000 },
    });
    const b = bots.create({
      name: "B",
      connectionId,
      symbols: ["DEMO-BTC"],
      pollMs: 120,
      barCount: 60,
      risk: { initialCash: 20_000, minTradeValue: 5000 },
    });

    const states = await bots.startMany([a.id, b.id]);
    assert.equal(states.length, 2);
    for (const st of states) {
      assert.equal(st.status, "running", `实时机器人启动后应在跑，实际 ${st.status}`);
      assert.ok(st.metrics, "应产出指标");
      // 预热只喂指标：启动瞬间既没有实时 K 线，也没有成交
      assert.equal(st.bars, 0, "实时 bars 从 0 开始计");
      assert.ok(st.warmupBars > 0, "应预热历史 K 线");
      assert.equal(st.trades.length, 0, "预热不产生成交");
    }

    // 成交随实时 tick 到来（不再是启动即跑完）
    await waitFor(() => (bots.state(a.id).metrics?.totalFills ?? 0) > 0);

    const va = bots.state(a.id).metrics!;
    const vb = bots.state(b.id).metrics!;
    // 不同标的 + 不同资金，结果不应相同（独立账户）
    assert.notEqual(va.finalEquity, vb.finalEquity);
    // 小资金的机器人受最小调仓额限制，成交明显更少
    assert.ok(vb.totalFills < va.totalFills, `最小调仓额应减少成交: ${va.totalFills} -> ${vb.totalFills}`);
    assert.ok(Math.abs(va.finalEquity - 100_000) > 0, "A 应有持仓浮动");

    // 每个机器人自带权益曲线：仪表盘画的是机器人，而不是另一次单账户引擎运行
    const curve = bots.state(a.id).equityCurve;
    assert.ok(curve.length >= 1, `机器人 A 应记录权益曲线，实际 ${curve.length} 点`);
    assert.ok(curve.length <= 400, `曲线点数应受限（上限 400），实际 ${curve.length}`);
    assert.ok(curve.every((p) => Number.isFinite(p.equity) && p.equity > 0), "曲线点应有效");

    bots.stop(a.id);
    bots.stop(b.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("机器人：各账号的资产配置互不影响（同一候选池，不同参数）", async () => {
  const { dir, bots, connectionId } = setup();
  try {
    // A：规则、只做多、快线敏感；B：规则、慢线、限制最多 50% 仓位
    const a = bots.create({
      name: "A账号",
      connectionId,
      symbols: ["600519", "DEMO-BTC"],
      barCount: 200,
      strategy: { fastWindow: 3, slowWindow: 8 },
      risk: { initialCash: 100_000 },
    });
    const b = bots.create({
      name: "B账号",
      connectionId,
      symbols: ["600519", "DEMO-BTC"],
      barCount: 200,
      strategy: { fastWindow: 8, slowWindow: 30 },
      risk: { initialCash: 30_000, maxPositionWeight: 0.5 },
    });

    await bots.startMany([a.id, b.id]);
    // 关掉实时轮询器，否则测试进程不会退出
    bots.stop(a.id);
    bots.stop(b.id);

    const va = bots.state(a.id).allocation!;
    const vb = bots.state(b.id).allocation!;
    assert.ok(va, "A 应有资产配置快照");
    assert.ok(vb, "B 应有资产配置快照");
    // 权益各自独立
    assert.ok(Math.abs(va.equity - vb.equity) > 0, `权益不应相同：${va.equity} vs ${vb.equity}`);
    // 权重加总 = 持仓权重 + 现金权重 = 1
    for (const v of [va, vb]) {
      const sum = v.holdings.reduce((a, h) => a + h.weight, 0) + v.cashWeight;
      assert.ok(Math.abs(sum - 1) < 0.01, `权重应加总为 1，实际 ${sum}`);
    }
    // B 的单标的上限更低：若有持仓，单个权重不得超过 0.5
    for (const h of vb.holdings) {
      assert.ok(h.weight <= 0.5 + 1e-6, `B 的 ${h.symbol} 权重 ${h.weight} 不应超过 50%`);
    }
    // 持仓明细自洽
    for (const h of va.holdings) {
      assert.ok(h.quantity > 0, "持仓数量应为正");
      assert.ok(Math.abs(h.marketValue - h.quantity * h.price) < 0.05);
      assert.ok(h.price > 0);
    }
    assert.equal(va.holdings.length, va.heldCount);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("机器人：重复启动会被拒绝，停止后状态更新", async () => {
  const { dir, bots, connectionId } = setup();
  try {
    const bot = bots.create({
      name: "A",
      connectionId,
      symbols: ["DEMO-BTC"],
      barCount: 60,
      pollMs: 100,
    });
    await bots.start(bot.id);
    assert.equal(bots.state(bot.id).status, "running", "实时机器人启动后保持 running");

    await assert.rejects(() => bots.start(bot.id), /已在运行/);
    await assert.rejects(() => bots.start("不存在"), /机器人不存在/);
    bots.stop(bot.id);
    assert.equal(bots.state(bot.id).status, "stopped", "stop 立即把状态置为 stopped");
    // 停掉之后再启动是允许的（不是永久锁死）
    await bots.start(bot.id);
    assert.equal(bots.state(bot.id).status, "running");
    bots.stop(bot.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("机器人：坏配置给出明确报错，删除后不再保留", async () => {
  const { dir, bots, connectionId } = setup();
  try {
    assert.throws(() => bots.create({ name: "", connectionId, symbols: ["DEMO-BTC"] }), /名称/);
    // 不校验"没选标的"：这个连接是模拟交易所，标的是它自带的（见 connections.test.ts）
    assert.throws(
      () => bots.create({ name: "X", connectionId: "nope", symbols: ["DEMO-BTC"] }),
      /连接不存在/,
    );

    const bot = bots.create({ name: "X", connectionId, symbols: ["DEMO-BTC"], barCount: 40 });
    await bots.start(bot.id);
    bots.remove(bot.id);
    assert.equal(bots.list().length, 0);
    assert.equal(bots.get(bot.id), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("机器人：配置持久化到 bots.json，重启后仍在", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-bots-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟盘" });
    const first = new BotManager(dir, testConfig(), connections, new LlmManager(dir));
    const created = first.create({
      name: "持久化",
      connectionId: conn.id,
      symbols: ["DEMO-BTC"],
      decisionSource: "chat",
      modelProfileIds: ["abc"],
    });

    const second = new BotManager(dir, testConfig(), connections, new LlmManager(dir));
    const loaded = second.list();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.name, "持久化");
    assert.deepEqual(loaded[0]!.modelProfileIds, ["abc"]);
    assert.equal(loaded[0]!.state.status, "idle");
    assert.equal(loaded[0]!.state.events.length, 0);
    // 指定了不存在的模型实例 -> 明确标出未配置
    assert.match(loaded[0]!.modelLabels.join(" "), /对话模型.*未配置/);
    assert.equal(loaded[0]!.decisionSource, "chat");
    assert.equal(created.id, loaded[0]!.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// ---------------- 实盘门槛与互斥 ----------------

/** 模拟适配器 supportsTrading=true、requiresKeys=false，用它验证"能不能真下单"的分支 */
function liveSetup(mode: "paper" | "live") {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-live-"));
  const connections = new ConnectionManager(dir);
  const conn = connections.create({ adapterId: "simulated", label: "模拟盘" });
  const config = { ...testConfig(), execution: { ...testConfig().execution, mode } };
  const bots = new BotManager(dir, config, connections, new LlmManager(dir));
  return { dir, bots, conn: conn.id };
}

test("实盘：实时模式 + 执行方式为真实下单 => 真的会发真实订单", async () => {
  const { dir, bots, conn } = liveSetup("live");
  try {
    const bot = bots.create({ name: "实盘机器人", connectionId: conn, symbols: ["DEMO-BTC"], mode: "live", paperTrading: false, barCount: 30 });
    const st = await bots.start(bot.id);
    assert.equal(st.liveTrading, true, "条件齐备时应标记为实盘");
    assert.equal(bots.state(bot.id).liveTrading, true);
    // 实时机器人会起轮询器（setInterval），不关掉的话测试进程不会退出
    bots.stop(bot.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("实盘：选了实时但执行方式仍是模拟 => 拒绝启动，而不是悄悄降级", async () => {
  const { dir, bots, conn } = liveSetup("paper");
  try {
    const bot = bots.create({ name: "想实盘", connectionId: conn, symbols: ["DEMO-BTC"], mode: "live", paperTrading: false, barCount: 30 });
    await assert.rejects(
      () => bots.start(bot.id),
      /设为真实下单.*执行方式仍是模拟成交.*不会启动/,
      "静默降级是最糟的结局：用户以为钱打出去了，实际没动",
    );
    assert.equal(bots.state(bot.id).status, "idle", "被拒绝后不应进入运行态");
    assert.equal(bots.state(bot.id).liveTrading, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("实盘：同一连接同时只允许一个实盘机器人", async () => {
  const { dir, bots, conn } = liveSetup("live");
  try {
    // 手动把一个机器人置为运行中（模拟"已经在实盘跑着"），避免真的并发等待
    const first = bots.create({ name: "实盘一号", connectionId: conn, symbols: ["DEMO-BTC"], mode: "live", paperTrading: false, barCount: 30 });
    const second = bots.create({ name: "实盘二号", connectionId: conn, symbols: ["DEMO-ETH"], mode: "live", paperTrading: false, barCount: 30 });
    bots["states"].set(first.id, { ...bots.state(first.id), status: "running", liveTrading: true });

    await assert.rejects(
      () => bots.start(second.id),
      /同一连接已有实盘机器人「实盘一号」在运行/,
      "并行下真单必须被挡住",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("模拟成交机器人不受实盘互斥限制，可与实盘机器人并行", async () => {
  const { dir, bots, conn } = liveSetup("live");
  try {
    const liveBot = bots.create({ name: "实盘", connectionId: conn, symbols: ["DEMO-BTC"], mode: "live", paperTrading: false, barCount: 30 });
    const paper = bots.create({ name: "模拟", connectionId: conn, symbols: ["DEMO-ETH"], mode: "live", paperTrading: true, barCount: 30 });
    bots["states"].set(liveBot.id, { ...bots.state(liveBot.id), status: "running", liveTrading: true });
    const st = await bots.start(paper.id);
    assert.equal(st.status, "running", "模拟成交机器人不应被实盘互斥挡住；启动后保持 running");
    assert.equal(st.liveTrading, false, "模拟成交永远不发真实订单");
    bots.stop(liveBot.id);
    bots.stop(paper.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("实盘：不同连接之间互不干扰", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-live2-"));
  try {
    const connections = new ConnectionManager(dir);
    const c1 = connections.create({ adapterId: "simulated", label: "盘一" });
    const c2 = connections.create({ adapterId: "simulated", label: "盘二" });
    const config = { ...testConfig(), execution: { ...testConfig().execution, mode: "live" } };
    const bots = new BotManager(dir, config, connections, new LlmManager(dir));

    const a = bots.create({ name: "A", connectionId: c1.id, symbols: ["DEMO-BTC"], mode: "live", paperTrading: false, barCount: 30 });
    const b = bots.create({ name: "B", connectionId: c2.id, symbols: ["DEMO-ETH"], mode: "live", paperTrading: false, barCount: 30 });
    bots["states"].set(a.id, { ...bots.state(a.id), status: "running", liveTrading: true });
    const st = await bots.start(b.id);
    assert.equal(st.status, "running", "不同连接可以各自实盘；实时启动后应保持 running");
    assert.equal(st.liveTrading, true);
    bots.stop(b.id); // 关掉实时轮询器
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("机器人也会给自我进化留痕（否则用了机器人等于关掉了进化）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-bot-evo-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟" });
    const config: AppConfig = {
      ...testConfig(),
      evolution: {
        ...testConfig().evolution,
        enabled: true,
        persist: false,
        minSamples: 5,
        cooldownMs: 0,
        evaluateMs: 600_000,
        horizonBars: 1,
        tunable: ["strategy.maxTargetWeight"],
      },
    };
    let latest: AppConfig = config;
    const evolution = new EvolutionEngine(dir, latest, (next) => {
      latest = next;
    });
    // 留痕挂在资产配置器上（AI 自主配置/混合决策那条路径），逐标的模式本来就不留痕
    const strategy = new StrategyStore(dir).create({ name: "AI 配置", selfAllocating: true, allocationInterval: 3 });
    const bots = new BotManager(dir, config, connections, new LlmManager(dir), undefined, evolution);
    const bot = bots.create({
      name: "留痕机器人",
      connectionId: conn.id,
      symbols: ["DEMO-BTC", "DEMO-ETH"],
      barCount: 60,
      pollMs: 100,
      strategyId: strategy.id,
    });
    await bots.start(bot.id);

    // 分配轮次每 3 根实时 K 线一次；预热不计入。等待至少一轮留痕。
    await waitFor(() => evolution.stats().total > 0, 12000);
    const stats = evolution.stats();
    assert.ok(stats.total > 0, `机器人运行后应留下决策记录（owner=bot:…），实际 ${stats.total} 条`);
    const recent = evolution.view().recentDecisions;
    assert.ok(recent.length > 0);
    assert.ok(
      recent.some((d) => String(d.owner).startsWith("bot:")),
      `记录应标明来自机器人，实际 owner=${recent[0]?.owner}`,
    );
    bots.stop(bot.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("配置热更新会同步到机器人（否则实盘判定读到旧的执行方式）", () => {
  // 回归：/api/config 只改了 controller，机器人手里的副本还是旧的 ——
  // 表现是「明明在界面上切到真实下单了，机器人启动时还说执行方式是模拟」。
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-cfg-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟" });
    const config = testConfig();
    const bots = new BotManager(dir, config, connections, new LlmManager(dir));

    const bot = bots.create({ name: "T", connectionId: conn.id, symbols: ["DEMO-BTC"], mode: "live", paperTrading: false, barCount: 20 });
    const next: AppConfig = { ...config, execution: { ...config.execution, mode: "live" } };
    bots.useConfig(next);

    return bots.start(bot.id).then(
      (st) => {
        assert.equal(st.status, "running", "同步配置后应能启动（模拟适配器支持交易且不需 Key）；实时启动后保持 running");
        assert.equal(st.liveTrading, true);
        bots.stop(bot.id);
      },
      (err) => {
        assert.fail(`同步配置后不应被拒绝: ${(err as Error).message}`);
      },
    ).finally(() => rmSync(dir, { recursive: true, force: true }));
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
});

test("模拟成交（默认）：实时机器人用真实行情本地撮合，产出交易统计", async () => {
  // 这是机器人最常用的跑法：行情是真的（东财/币安拉下来的），撮合在本地，
  // 零资金风险。它绝不能因为「执行方式=模拟」被拒绝启动 —— 之前恰恰是这个
  // 门把所有实时机器人都挡在了门外，用户根本没法跑。
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-paper-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟行情" });
    const config = testConfig(); // execution.mode = paper
    const bots = new BotManager(dir, config, connections, new LlmManager(dir));

    // paperTrading 缺省 = true：实时 + 模拟成交，应当能启动
    const bot = bots.create({ name: "干跑", connectionId: conn.id, symbols: ["DEMO-BTC"], mode: "live", paperTrading: true, barCount: 40 });
    const st = await bots.start(bot.id);
    assert.equal(st.liveTrading, false, "模拟成交绝不是实盘");
    assert.equal(st.status, "running", "实时机器人启动后保持 running（轮询器在跑）");
    assert.equal(st.error, null);
    assert.equal(st.trades.length, 0, "预热不产生成交");
    assert.equal(st.bars, 0, "实时 bars 从 0 开始");
    assert.ok(st.warmupBars > 0, "预热历史 K 线已就绪");
    // 成交随实时 tick 到来
    await waitFor(() => (bots.state(bot.id).metrics?.totalFills ?? 0) > 0);
    const st2 = bots.state(bot.id);
    // 交易统计三件套必须产出 —— "统计这个机器人的交易情况和盈利情况"靠它们
    assert.ok(st2.trades.length > 0, `应留下成交流水，实际 ${st2.trades.length} 条`);
    assert.ok(st2.pnlBySymbol.length > 0, "应有分标的盈亏统计");
    assert.ok(st2.metrics, "应有盈利指标");
    bots.stop(bot.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("模拟成交：实时机器人不受实盘互斥限制，可多个并行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-paper2-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟行情" });
    const config = testConfig();
    const bots = new BotManager(dir, config, connections, new LlmManager(dir));

    const a = bots.create({ name: "干跑A", connectionId: conn.id, symbols: ["DEMO-BTC"], mode: "live", paperTrading: true, barCount: 40 });
    const b = bots.create({ name: "干跑B", connectionId: conn.id, symbols: ["DEMO-ETH"], mode: "live", paperTrading: true, barCount: 40 });
    bots["states"].set(a.id, { ...bots.state(a.id), status: "running", liveTrading: false });
    const st = await bots.start(b.id);
    assert.equal(st.status, "running", "模拟成交机器人不应被实盘互斥挡住；启动后保持 running");
    bots.stop(a.id);
    bots.stop(b.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("交易统计：成交流水与分标的盈亏来自机器人自己的成交", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-trade-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟行情" });
    const bots = new BotManager(dir, testConfig(), connections, new LlmManager(dir));
    const bot = bots.create({ name: "统计", connectionId: conn.id, symbols: ["DEMO-BTC", "DEMO-ETH"], barCount: 120, pollMs: 100 });
    const st = await bots.start(bot.id);

    assert.equal(st.trades.length, 0, "预热不产生成交");
    assert.equal(st.bars, 0, "实时 bars 从 0 开始");
    assert.ok(st.warmupBars > 0, "预热历史 K 线已就绪");

    // 等待两个标的都有成交
    await waitFor(() => (bots.state(bot.id).metrics?.totalFills ?? 0) > 0, 15000);

    const st2 = bots.state(bot.id);
    assert.ok(st2.trades.length > 0);
    // 明细字段齐全：价格、数量、手续费、理由
    const t = st2.trades[0]!;
    assert.ok(t.price > 0 && t.quantity > 0, "成交必须有价格与数量");
    assert.ok(typeof t.fee === "number", "应有手续费");
    assert.ok(t.reason.length > 0, "应有决策理由");
    // 分标的盈亏：两个标的都动过，合计应等于总已实现盈亏
    const sum = st2.pnlBySymbol.reduce((acc, p) => acc + p.realizedPnl, 0);
    assert.ok(
      Math.abs(sum - (st2.metrics?.realizedPnl ?? 0)) < 0.01,
      `分标的盈亏合计 ${sum} 应等于总已实现盈亏 ${st2.metrics?.realizedPnl}`,
    );
    assert.ok(st2.pnlBySymbol.every((p) => p.fills > 0), "出现在表里的标的必有成交");
    assert.ok(st2.pnlBySymbol.length >= 1);
    bots.stop(bot.id); // 关轮询器，否则测试进程不会退出
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("老数据迁移：没有 paperTrading 字段的机器人补默认值 true（保守）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-mig-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟" });
    const config = testConfig();
    // 直接写一份"旧版"bots.json：没有 paperTrading 字段
    const legacy = [
      {
        id: "old1",
        name: "老机器人",
        enabled: true,
        connectionId: conn.id,
        symbols: ["DEMO-BTC"],
        mode: "live",
        interval: "1m",
        barCount: 30,
        pollMs: 1000,
        decisionSource: "rules",
        modelProfileIds: [],
        decisionInterval: 5,
        strategy: { fastWindow: 5, slowWindow: 20 },
        risk: { initialCash: 100000 },
        createdAt: new Date().toISOString(),
      },
    ];
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    writeFileSync(join(dir, "bots.json"), JSON.stringify(legacy, null, 2));

    const bots = new BotManager(dir, config, connections, new LlmManager(dir));
    const view = bots.list()[0]!;
    assert.equal(
      view.paperTrading,
      true,
      "老机器人的 paperTrading 必须默认为 true：把旧机器人默认成真下单是不可接受的",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("实时机器人启动后必须保持 running（轮询器在跑，start 返回即停是假状态）", async () => {
  // 回归：runLive 预热完、启动轮询器就返回，start() 曾无条件把状态标成
  // stopped —— 机器人明明在跑却显示已停止，还能对它叠着再启动一个轮询器。
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-running-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟行情" });
    const bots = new BotManager(dir, testConfig(), connections, new LlmManager(dir));

    const bot = bots.create({ name: "常驻", connectionId: conn.id, symbols: ["DEMO-BTC"], paperTrading: true, barCount: 40, pollMs: 200 });
    await bots.start(bot.id);
    const st = bots.state(bot.id);
    assert.equal(st.status, "running", "start() 返回后实时机器人必须仍是 running");
    assert.ok(st.warmupBars > 0, "预热应已产出历史 K 线");

    // 轮询器活着：等两轮，实时 bars 必须增长
    const before = bots.state(bot.id).bars;
    await new Promise((r) => setTimeout(r, 600));
    const after = bots.state(bot.id).bars;
    assert.ok(after > before, `轮询应推进实时 K 线数：${before} -> ${after}`);

    // 状态为 running 时重复启动必须被拒绝（防止叠轮询器）
    await assert.rejects(() => bots.start(bot.id), /已在运行/);

    bots.stop(bot.id);
    await waitFor(() => bots.state(bot.id).status === "stopped");
    assert.equal(bots.state(bot.id).status, "stopped", "stop 后才是 stopped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("运行存档：stop 后写盘，重启进程（重建 BotManager）后历史仍在", async () => {
  // 这是「机器人战绩」能不能留下来的根：重启只重放配置不重放战绩，
  // 长期是赚是赔就永远没有答案。endRun 必须落盘、loadHistory 必须读回。
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-runhist-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟行情" });
    const config = testConfig();
    const bots = new BotManager(dir, config, connections, new LlmManager(dir));
    const bot = bots.create({ name: "存档", connectionId: conn.id, symbols: ["DEMO-BTC"], barCount: 120, pollMs: 100 });

    await bots.start(bot.id);
    await waitFor(() => (bots.state(bot.id).metrics?.totalFills ?? 0) > 0);
    bots.stop(bot.id);
    await waitFor(() => bots.state(bot.id).status === "stopped");

    const v1 = bots.list()[0]!;
    assert.equal(v1.history.length, 1, "应留下一次运行存档");
    const rec = v1.history[0]!;
    assert.equal(rec.status, "stopped");
    assert.ok(rec.metrics, "存档应含盈利指标");
    assert.ok(rec.trades.length > 0, "存档应含成交流水");
    assert.ok(rec.equityCurve.length > 0, "存档应含曲线");
    assert.equal(rec.tradesTruncated, false, "未截断必须如实标注 false");

    // 重启：新建一个 BotManager（模拟进程重启）
    const bots2 = new BotManager(dir, config, connections, new LlmManager(dir));
    const v2 = bots2.list()[0]!;
    assert.equal(v2.history.length, 1, "重启后历史必须仍在");
    assert.equal(v2.totals.runs, 1);
    assert.equal(v2.totals.totalFills, v2.history[0]!.metrics?.totalFills ?? -1);
    assert.ok(v2.totals.lastRunAt, "应记录最近运行时间");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("运行存档汇总：多次运行求和、胜负统计只算已结束的运行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-runhist2-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟行情" });
    const bots = new BotManager(dir, testConfig(), connections, new LlmManager(dir));
    const bot = bots.create({ name: "两轮", connectionId: conn.id, symbols: ["DEMO-BTC"], barCount: 120, pollMs: 100 });

    // 第一轮
    await bots.start(bot.id);
    await waitFor(() => (bots.state(bot.id).metrics?.totalFills ?? 0) > 0);
    bots.stop(bot.id);
    await waitFor(() => bots.state(bot.id).status === "stopped");

    // 第二轮
    await bots.start(bot.id);
    await waitFor(() => (bots.state(bot.id).metrics?.totalFills ?? 0) > 0);
    bots.stop(bot.id);
    await waitFor(() => bots.state(bot.id).status === "stopped");

    const v = bots.list()[0]!;
    assert.equal(v.history.length, 2, "两次运行两条存档");

    // 汇总口径：各次独立从初始资金开始（非复利），累计是已实现盈亏之和
    const sumPnl = v.history.reduce((acc, r) => acc + (r.metrics?.realizedPnl ?? 0), 0);
    assert.ok(Math.abs(v.totals.cumulativeRealizedPnl - sumPnl) < 0.01, "累计已实现盈亏应等于各次之和");
    assert.equal(v.totals.totalFills, v.history.reduce((a, r) => a + (r.metrics?.totalFills ?? 0), 0));
    const expectedWins = v.history.filter((r) => (r.metrics?.totalReturn ?? 0) > 0).length;
    const expectedLosses = v.history.filter((r) => (r.metrics?.totalReturn ?? 0) < 0).length;
    assert.equal(v.totals.wins, expectedWins);
    assert.equal(v.totals.losses, expectedLosses);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("运行存档：明细被截断时必须如实标注（不能让人以为看到的是全部）", async () => {
  // 只留尾部若干笔省空间可以接受，但界面若把它当全部就是在骗人。
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-runhist3-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟行情" });
    const bots = new BotManager(dir, testConfig(), connections, new LlmManager(dir));
    const bot = bots.create({ name: "高频", connectionId: conn.id, symbols: ["DEMO-BTC"], barCount: 400 });
    await bots.start(bot.id);
    bots.stop(bot.id);
    const rec = bots.list()[0]!.history[0]!;
    const total = rec.metrics?.totalFills ?? 0;
    if (total > HISTORY_TRADES_PER_RUN) {
      assert.equal(rec.trades.length, HISTORY_TRADES_PER_RUN, "截断到上限");
      assert.equal(rec.tradesTruncated, true, "截断必须标注");
    } else {
      assert.equal(rec.trades.length, total, "不截断时应保留全部");
      assert.equal(rec.tradesTruncated, false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("运行存档：机器人删除后存档一并消失（不留幽灵数据）", () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-runhist4-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟行情" });
    const bots = new BotManager(dir, testConfig(), connections, new LlmManager(dir));
    const bot = bots.create({ name: "瞬逝", connectionId: conn.id, symbols: ["DEMO-BTC"], barCount: 60 });
    bots.stop(bot.id);
    bots.remove(bot.id);

    // 重启后不应看到已删机器人的存档
    const bots2 = new BotManager(dir, testConfig(), connections, new LlmManager(dir));
    assert.equal(bots2.list().length, 0);
    const raw = existsSync(join(dir, "bots-history.json"))
      ? (JSON.parse(readFileSync(join(dir, "bots-history.json"), "utf8")) as Record<string, unknown>)
      : {};
    assert.ok(!(bot.id in raw), `已删机器人的存档应清除，实际 ${JSON.stringify(raw).slice(0, 80)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("运行存档：正在运行的快照有节流，不会每次轮询都写盘", async () => {
  // 节流表记在内存里（记在 record 上会算错时间窗，导致只写第一次）。
  // 验证：强制写一次后立刻再写应该被跳过。
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-runhist5-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟行情" });
    const bots = new BotManager(dir, testConfig(), connections, new LlmManager(dir));
    const bot = bots.create({ name: "节流", connectionId: conn.id, symbols: ["DEMO-BTC"], mode: "live", paperTrading: true, barCount: 40, pollMs: 200 });
    await bots.start(bot.id);
    const rec0 = bots.list()[0]!.history[0]!;
    assert.equal(rec0.status, "running", "运行中的存档应是 running");
    assert.ok(rec0.metrics, "预热后应已有快照");

    // 节流期内：把存档内容改坏（标记），再触发一次非强制 checkpooint，应不被覆盖
    rec0.metrics = null;
    bots["checkpointRun"](bot);
    assert.equal(bots.list()[0]!.history[0]!.metrics, null, "节流期内不应再次写盘");

    // 强制写：恢复
    bots["checkpointRun"](bot, true);
    assert.ok(bots.list()[0]!.history[0]!.metrics, "强制写应更新快照");
    bots.stop(bot.id);
    assert.equal(bots.list()[0]!.history[0]!.status, "stopped", "stop 后应收尾");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("运行存档：上次进程遗留的 running 存档必须标为中断（否则幽灵状态永远显示运行中）", () => {
  // 进程被 kill 时没有机会 endRun —— 存档会永远停在"运行中"。
  // 界面若一直显示"运行中"，用户等到天荒地老也不会看到结局。
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-stale-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟" });
    const config = testConfig();

    // 先建机器人拿到 id，再写一份"上次进程"留下的运行中存档
    const bots0 = new BotManager(dir, config, connections, new LlmManager(dir));
    const id = bots0.create({ name: "被杀", connectionId: conn.id, symbols: ["DEMO-BTC"], mode: "live", paperTrading: true, barCount: 30 }).id;
    writeFileSync(
      join(dir, "bots-history.json"),
      JSON.stringify({
        [id]: [
          {
            id: "ghost",
            botId: id,
            name: "被杀",
            mode: "live",
            paperTrading: true,
            liveTrading: false,
            status: "running",
            startedAt: new Date(Date.now() - 600_000).toISOString(),
            finishedAt: null,
            durationMs: 42,
            bars: 3,
            symbols: ["DEMO-BTC"],
            strategyName: "默认策略",
            metrics: null,
            equityCurve: [],
            trades: [],
            tradesTruncated: false,
            pnlBySymbol: [],
            error: null,
          },
        ],
      }),
    );

    // 新进程起来：必须把 running 残局标掉
    const bots = new BotManager(dir, config, connections, new LlmManager(dir));
    const view = bots.list()[0]!;
    const rec = view.history.find((r) => r.id === "ghost")!;
    assert.ok(rec, "应读回上次的存档");
    assert.equal(rec.status, "error", "running 残局必须标掉");
    assert.ok((rec.error ?? "").includes("中断"), "应说明是中断，而不是当成跑完");
    // 残局不该计入胜负统计（没有收益可言）
    assert.equal(view.totals.wins + view.totals.losses, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("操作指引：把机器人的目标仓位换算成可人工照做的交易清单", async () => {
  // 模拟盘与实盘唯一差别是不下单，所以"还差多少才到位"必须能算出来给人事先照做。
  // 不敢全权交给机器人、或交易所不支持 API 交易时，就靠这份清单手动跟进。
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-actions-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟行情" });
    const bots = new BotManager(dir, testConfig(), connections, new LlmManager(dir));
    const bot = bots.create({ name: "指引", connectionId: conn.id, symbols: ["DEMO-BTC"], barCount: 60, pollMs: 100 });

    await bots.start(bot.id);
    // 还没出决策时不能编造操作
    assert.equal(bots.state(bot.id).actions.length, 0, "尚无决策时不该给操作指引");

    await waitFor(() => bots.state(bot.id).actions.length > 0, 15000);
    const st = bots.state(bot.id);
    const acts = st.actions;
    // 有决策就必须有目标权重可对照（否则指引无从算起）
    assert.ok(st.allocation, "应有资产配置快照");
    assert.ok(Object.keys(st.allocation!.targets).length > 0, "应捕获最新目标权重");
    assert.ok(st.allocation!.decidedAt, "应记录决策时间");
    assert.ok(Object.keys(st.allocation!.prices).length > 0, "应带出最新价，否则指引算不出数量");

    for (const a of acts) {
      assert.ok(a.side === "BUY" || a.side === "SELL" || a.side === "HOLD");
      if (a.side === "HOLD") {
        assert.ok(a.note && a.note.length > 0, "不操作必须说明原因，否则看起来像卡住了");
        // 原因必须对得上事实：目标与当前都为 0 时说"目标空仓"，
        // 说成"差额小于最小调仓额 0"既自相矛盾又误导
        if (a.fromWeight < 1e-6 && a.toWeight < 1e-6) {
          assert.match(a.note!, /目标空仓/, `空仓观望不该说成调仓额：${a.note}`);
        } else {
          assert.match(a.note!, /最小调仓额/, `有仓位差额时应说明调仓额：${a.note}`);
        }
        continue;
      }
      assert.ok(a.price > 0, `${a.symbol} 参考价必须来自行情`);
      assert.ok(a.quantity > 0, `${a.symbol} 必须给出可执行的数量`);
      assert.ok(Math.abs(a.value - a.quantity * a.price) < Math.max(0.05, a.value * 0.01), "金额应等于数量×参考价");
      assert.ok(a.reason.length > 0, "必须带着决策理由，人才知道为什么这么做");
    }
    bots.stop(bot.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("预热的历史 K 线仍进 get_history 数据源（否则模型查不到走势）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-histlog-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟行情" });
    const bots = new BotManager(dir, testConfig(), connections, new LlmManager(dir));
    const bot = bots.create({ name: "历史", connectionId: conn.id, symbols: ["DEMO-BTC"], barCount: 50, pollMs: 100 });
    await bots.start(bot.id);

    // 预热不进交易，但必须进 historyLog（工具的数据源）
    const log = bots["historyLog"].get("DEMO-BTC") ?? [];
    assert.ok(log.length >= 50, `预热 K 线应进 historyLog，实际 ${log.length}`);
    assert.ok(log.every((p) => typeof p.close === "number" && p.close > 0), "historyLog 记录应带有效收盘价");
    bots.stop(bot.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("老数据迁移：旧的回测机器人改为实时 + 模拟成交（历史模拟已移往回测页）", () => {
  // 回测机器人本来就只在本地撮合，从不发真实订单；改成实时不改变资金行为，
  // 只是不再让它冒充"跑历史的机器人"。
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-migbt-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟" });
    const legacy = [
      {
        id: "oldbt",
        name: "旧回测机器人",
        enabled: true,
        connectionId: conn.id,
        symbols: ["DEMO-BTC"],
        mode: "backtest",
        interval: "1m",
        barCount: 30,
        pollMs: 1000,
        decisionSource: "rules",
        modelProfileIds: [],
        decisionInterval: 5,
        strategy: { fastWindow: 5, slowWindow: 20 },
        risk: { initialCash: 100000 },
        createdAt: new Date().toISOString(),
      },
    ];
    writeFileSync(join(dir, "bots.json"), JSON.stringify(legacy, null, 2));
    const bots = new BotManager(dir, testConfig(), connections, new LlmManager(dir));
    const view = bots.list()[0]!;
    assert.equal(view.mode, "live", "旧回测机器人应改为实时");
    assert.equal(view.paperTrading, true, "必须同时是模拟成交");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("事件日志：实时决策要记进状态（界面的事件面板不是死元素）", async () => {
  // 回归：事件一直被写进 this.events 却从没读回 BotState，
  // 结果「最近事件」面板永远是空的 —— 看起来有功能，实际是死的。
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-events-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟行情" });
    const bots = new BotManager(dir, testConfig(), connections, new LlmManager(dir));
    const bot = bots.create({ name: "事件", connectionId: conn.id, symbols: ["DEMO-BTC"], barCount: 60, pollMs: 100 });

    await bots.start(bot.id);
    // 预热不产生事件：否则用户会看到"一启动就几十条决策"
    assert.equal(bots.state(bot.id).events.length, 0, "预热期间不应记录事件");

    await waitFor(() => bots.state(bot.id).events.length > 0, 15000);
    const evs = bots.state(bot.id).events;
    assert.ok(evs.length > 0, "实时决策应进入事件日志");
    // 新的在前：界面直接按这个顺序渲染
    const times = evs.map((e) => Date.parse(e.timestamp));
    assert.deepEqual(times, [...times].sort((x, y) => y - x), "事件应按时间倒序（新的在前）");
    assert.ok(evs.every((e) => e.summary.length > 0), "每条事件都要有可读的摘要");
    bots.stop(bot.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("资产配置：权重必须自洽（持仓之和 + 现金 = 100%，市值之和 + 现金 = 权益）", async () => {
  // 界面那一栏是给人数用的：加起来不是 100%，用户没法判断该信哪个。
  // 这是一条契约，不是一个已修的 bug —— 权益 = 现金 + Σ持仓市值，
  // 权重就是各自市值/权益，所以恒等于 1；哪天改坏了这里先失败。
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-weight-"));
  try {
    const connections = new ConnectionManager(dir);
    const conn = connections.create({ adapterId: "simulated", label: "模拟行情" });
    const bots = new BotManager(dir, testConfig(), connections, new LlmManager(dir));
    const bot = bots.create({
      name: "权重",
      connectionId: conn.id,
      symbols: ["DEMO-BTC", "DEMO-ETH", "600519"],
      barCount: 60,
      pollMs: 120,
      strategy: { fastWindow: 3, slowWindow: 8 },
    });
    await bots.start(bot.id);

    const deadline = Date.now() + 15000;
    let checked = 0;
    while (Date.now() < deadline) {
      const a = bots.state(bot.id).allocation;
      if (a && a.holdings.length > 0) {
        const weightSum = a.holdings.reduce((s, h) => s + h.weight, 0) + a.cashWeight;
        assert.ok(
          Math.abs(weightSum - 1) < 0.005,
          `权重之和应约为 1，实际 ${weightSum}（持仓 ${a.holdings.map((h) => `${h.symbol}=${h.weight}`).join(",")} 现金=${a.cashWeight}）`,
        );
        const valueSum = a.holdings.reduce((s, h) => s + h.marketValue, 0) + a.cash;
        assert.ok(
          Math.abs(valueSum - a.equity) < 1,
          `持仓市值之和 + 现金 应等于权益：${valueSum} vs ${a.equity}`,
        );
        checked += 1;
        if (checked >= 3) break;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.ok(checked > 0, "应至少抓到一次有持仓的配置快照来校验");
    bots.stop(bot.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
