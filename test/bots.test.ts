/** 交易机器人：多个自动化交易并行、互不干扰，各自独立配置模型与策略。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotManager } from "../src/bots/botManager.js";
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
    // 规则路标注为纯规则，并显示配比
    assert.deepEqual(bots.list()[0]!.modelLabels, ["规则 100%"]);
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
    // 指定了不存在的模型实例 -> 明确标出「未配置，不参与」
    assert.match(loaded[0]!.modelLabels.join(" "), /对话模型.*未配置/);
    assert.deepEqual(loaded[0]!.sources, ["chat"]);
    assert.equal(loaded[0]!.blend.chat, 1);
    assert.equal(created.id, loaded[0]!.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});