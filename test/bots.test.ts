/** 交易机器人：多个自动化交易并行、互不干扰，各自独立配置模型与策略。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotManager } from "../src/bots/botManager.js";
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

test("机器人：可创建多个，各自保存独立配置", () => {
  const { dir, bots, connectionId } = setup();
  try {
    const a = bots.create({ name: "BTC 趋势", connectionId, symbols: ["DEMO-BTC"], mode: "backtest" });
    const b = bots.create({
      name: "A股均线",
      connectionId,
      symbols: ["600519"],
      mode: "backtest",
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

test("机器人：回测并行运行，资金与成交各自独立", async () => {
  const { dir, bots, connectionId } = setup();
  try {
    const a = bots.create({
      name: "A",
      connectionId,
      symbols: ["600519"],
      mode: "backtest",
      barCount: 200,
      risk: { initialCash: 100_000 },
    });
    const b = bots.create({
      name: "B",
      connectionId,
      symbols: ["DEMO-BTC"],
      mode: "backtest",
      barCount: 200,
      risk: { initialCash: 20_000, minTradeValue: 5000 },
    });

    const states = await bots.startMany([a.id, b.id]);
    assert.equal(states.length, 2);
    for (const st of states) {
      assert.equal(st.status, "stopped", `机器人 ${st.id} 应跑完即停，实际 ${st.status}`);
      assert.ok(st.metrics, "应产出指标");
      assert.equal(st.bars, 200, "应处理完 200 根 K 线");
    }

    const va = bots.state(a.id).metrics!;
    const vb = bots.state(b.id).metrics!;
    // 不同标的 + 不同资金，结果不应相同（独立账户）
    assert.notEqual(va.finalEquity, vb.finalEquity);
    // 小资金的机器人受最小调仓额限制，成交明显更少
    assert.ok(vb.totalFills < va.totalFills, `最小调仓额应减少成交: ${va.totalFills} -> ${vb.totalFills}`);
    assert.ok(Math.abs(va.finalEquity - 100_000) > 0, "A 应有持仓浮动");

    // 每个机器人自带权益曲线：仪表盘画的是机器人，而不是另一次单账户引擎运行
    for (const [id, m] of [[a.id, va], [b.id, vb]] as const) {
      const curve = bots.state(id).equityCurve;
      assert.ok(curve.length > 1, `机器人 ${id} 应记录权益曲线，实际 ${curve.length} 点`);
      assert.ok(curve.length <= 400, `曲线点数应受限（上限 400），实际 ${curve.length}`);
      // 曲线按时间单调递增（时间戳），且末点与指标里的最终权益一致
      const times = curve.map((p) => Date.parse(p.timestamp));
      assert.deepEqual(times, [...times].sort((x, y) => x - y), "曲线应按时间升序");
      // 曲线按 2 位小数落盘（PortfolioManager 统一 round），指标是原值，故留 0.01 容差
      assert.ok(
        Math.abs(curve.at(-1)!.equity - m.finalEquity) < 0.01,
        `曲线末点应等于最终权益：${curve.at(-1)!.equity} vs ${m.finalEquity}`,
      );
      assert.ok(curve.every((p) => Number.isFinite(p.equity) && p.equity > 0), "曲线点应有效");
    }
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
      mode: "backtest",
      barCount: 200,
      strategy: { fastWindow: 3, slowWindow: 8 },
      risk: { initialCash: 100_000 },
    });
    const b = bots.create({
      name: "B账号",
      connectionId,
      symbols: ["600519", "DEMO-BTC"],
      mode: "backtest",
      barCount: 200,
      strategy: { fastWindow: 8, slowWindow: 30 },
      risk: { initialCash: 30_000, maxPositionWeight: 0.5 },
    });

    await bots.startMany([a.id, b.id]);

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
      mode: "backtest",
      barCount: 60,
    });
    await bots.start(bot.id);
    assert.equal(bots.state(bot.id).status, "stopped");

    await assert.rejects(() => bots.start("不存在"), /机器人不存在/);
    bots.stop(bot.id); // 停一个已结束的机器人不应抛错
    assert.equal(bots.state(bot.id).status, "stopped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("机器人：坏配置给出明确报错，删除后不再保留", async () => {
  const { dir, bots, connectionId } = setup();
  try {
    assert.throws(() => bots.create({ name: "", connectionId, symbols: ["DEMO-BTC"] }), /名称/);
    assert.throws(() => bots.create({ name: "X", connectionId, symbols: [] }), /标的/);
    assert.throws(
      () => bots.create({ name: "X", connectionId: "nope", symbols: ["DEMO-BTC"] }),
      /连接不存在/,
    );

    const bot = bots.create({ name: "X", connectionId, symbols: ["DEMO-BTC"], mode: "backtest", barCount: 40 });
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

test("实盘：回测机器人不受互斥限制，可与实盘机器人并行", async () => {
  const { dir, bots, conn } = liveSetup("live");
  try {
    const liveBot = bots.create({ name: "实盘", connectionId: conn, symbols: ["DEMO-BTC"], mode: "live", paperTrading: false, barCount: 30 });
    const backtest = bots.create({ name: "回测", connectionId: conn, symbols: ["DEMO-ETH"], mode: "backtest", barCount: 30 });
    bots["states"].set(liveBot.id, { ...bots.state(liveBot.id), status: "running", liveTrading: true });
    const st = await bots.start(backtest.id);
    assert.equal(st.status, "stopped", "回测不应被实盘互斥影响");
    assert.equal(st.liveTrading, false, "回测永远不发真实订单");
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
      mode: "backtest",
      barCount: 80,
      strategyId: strategy.id,
    });
    await bots.start(bot.id);

    const stats = evolution.stats();
    assert.ok(stats.total > 0, `机器人运行后应留下决策记录（owner=bot:…），实际 ${stats.total} 条`);
    const recent = evolution.view().recentDecisions;
    assert.ok(recent.length > 0);
    assert.ok(
      recent.some((d) => String(d.owner).startsWith("bot:")),
      `记录应标明来自机器人，实际 owner=${recent[0]?.owner}`,
    );
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
    // 交易统计三件套必须产出 —— "统计这个机器人的交易情况和盈利情况"靠它们
    assert.ok(st.trades.length > 0, `应留下成交流水，实际 ${st.trades.length} 条`);
    assert.ok(st.pnlBySymbol.length > 0, "应有分标的盈亏统计");
    assert.ok(st.metrics, "应有盈利指标");
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
    const bot = bots.create({ name: "统计", connectionId: conn.id, symbols: ["DEMO-BTC", "DEMO-ETH"], mode: "backtest", barCount: 120 });
    const st = await bots.start(bot.id);

    assert.ok(st.trades.length > 0);
    // 明细字段齐全：价格、数量、手续费、理由
    const t = st.trades[0]!;
    assert.ok(t.price > 0 && t.quantity > 0, "成交必须有价格与数量");
    assert.ok(typeof t.fee === "number", "应有手续费");
    assert.ok(t.reason.length > 0, "应有决策理由");
    // 分标的盈亏：两个标的都动过，合计应等于总已实现盈亏
    const sum = st.pnlBySymbol.reduce((acc, p) => acc + p.realizedPnl, 0);
    assert.ok(
      Math.abs(sum - (st.metrics?.realizedPnl ?? 0)) < 0.01,
      `分标的盈亏合计 ${sum} 应等于总已实现盈亏 ${st.metrics?.realizedPnl}`,
    );
    assert.ok(st.pnlBySymbol.every((p) => p.fills > 0), "每个标的的成交笔数应大于 0");
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

    const bot = bots.create({ name: "常驻", connectionId: conn.id, symbols: ["DEMO-BTC"], mode: "live", paperTrading: true, barCount: 40, pollMs: 200 });
    await bots.start(bot.id);
    const st = bots.state(bot.id);
    assert.equal(st.status, "running", "start() 返回后实时机器人必须仍是 running");
    assert.ok(st.bars > 0, "预热应已产出 K 线");

    // 轮询器活着：等两轮，bars 必须增长
    const before = bots.state(bot.id).bars;
    await new Promise((r) => setTimeout(r, 600));
    const after = bots.state(bot.id).bars;
    assert.ok(after > before, `轮询应推进 K 线数：${before} -> ${after}`);

    // 状态为 running 时重复启动必须被拒绝（防止叠轮询器）
    await assert.rejects(() => bots.start(bot.id), /已在运行/);

    bots.stop(bot.id);
    assert.equal(bots.state(bot.id).status, "stopped", "stop 后才是 stopped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
