/**
 * 策略列表：策略成为独立实体后的行为约束。
 *
 * 判定标准都是「可观测的事实」，不是字段存不存在：
 * - 同一策略被两个机器人引用时，改一次两边一起变（这正是做这个功能的意义）
 * - 引用失效（策略被删/不存在）不能让机器人起不来
 * - 迁移：老机器人内联参数会固化成一条策略，且**不能丢掉决策来源**
 * - 默认策略是单次运行用的那条
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StrategyStore } from "../src/strategies/profileStore.js";
import { BotManager } from "../src/bots/botManager.js";
import { ConnectionManager } from "../src/exchanges/connectionManager.js";
import { LlmManager } from "../src/llm/llmManager.js";
import { testConfig } from "./helpers.js";
import type { BotConfig } from "../src/bots/types.js";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "aaaaai-strat-"));
}

test("策略列表：首次启动从旧配置迁移出默认策略，参数一一对应", () => {
  const d = dir();
  try {
    const base = testConfig();
    const store = new StrategyStore(d, {
      seed: {
        name: "默认策略",
        decisionSource: base.strategy.decisionSource,
        fastWindow: base.strategy.fastWindow,
        slowWindow: base.strategy.slowWindow,
        maxTargetWeight: base.strategy.maxTargetWeight,
        selfAllocating: base.strategy.selfAllocating,
        maxPositions: base.strategy.maxPositions,
        maxGrossExposure: base.strategy.maxGrossExposure,
        allocationInterval: base.strategy.allocationInterval,
        hybridInfluence: base.strategy.hybridInfluence,
        hybridAnalysisTtlMs: base.strategy.hybridAnalysisTtlMs,
      },
    });
    const list = store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, "默认策略");
    assert.equal(list[0]!.fastWindow, base.strategy.fastWindow);
    assert.equal(list[0]!.slowWindow, base.strategy.slowWindow);
    assert.equal(list[0]!.decisionSource, base.strategy.decisionSource);
    assert.equal(store.default().id, list[0]!.id);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("策略列表：增删改查与复制，复制带走全部参数", () => {
  const d = dir();
  try {
    const store = new StrategyStore(d);
    const a = store.create({ name: "激进趋势", decisionSource: "chat", fastWindow: 3, slowWindow: 9, maxTargetWeight: 0.9 });
    assert.equal(store.list().length, 2);
    assert.equal(store.get(a.id)!.fastWindow, 3);

    const copy = store.duplicate(a.id);
    assert.notEqual(copy.id, a.id);
    assert.equal(copy.fastWindow, 3);
    assert.equal(copy.slowWindow, 9);
    assert.equal(copy.maxTargetWeight, 0.9);
    assert.equal(copy.decisionSource, "chat", "复制必须连决策来源一起带走");

    const updated = store.update(a.id, { fastWindow: 4 });
    assert.equal(updated.fastWindow, 4);
    assert.equal(store.get(copy.id)!.fastWindow, 3, "改 A 不影响它的副本");

    store.remove(copy.id);
    assert.equal(store.list().length, 2);
    // 重名自动加序号，不会互相覆盖
    const dup = store.create({ name: "激进趋势" });
    assert.equal(dup.name, "激进趋势 2");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("策略列表：默认策略不可删除、且至少保留一条", () => {
  const d = dir();
  try {
    const store = new StrategyStore(d);
    const def = store.default();
    assert.throws(() => store.remove(def.id), /默认策略不能删除/);

    const other = store.create({ name: "备用" });
    store.setDefault(other.id);
    assert.equal(store.default().id, other.id);
    assert.throws(() => store.remove(other.id), /默认策略不能删除/);

    store.remove(def.id);
    assert.equal(store.list().length, 1);
    // 现在 other 既是默认也是最后一条 —— 提示要指向「默认」而不是泛泛的「至少留一条」
    assert.throws(() => store.remove(other.id), /默认策略不能删除/);
    // 提示顺序正确：即使只剩一条，报错也该说的是「默认策略不能删」
    assert.throws(() => store.remove(store.default().id), /默认策略不能删除/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("策略列表：参数越界自动收敛，非法决策来源退回量化交易", () => {
  const d = dir();
  try {
    const store = new StrategyStore(d);
    const s = store.create({
      name: "越界",
      decisionSource: "瞎写" as never,
      fastWindow: 0,
      slowWindow: 1,
      maxTargetWeight: 99,
      hybridInfluence: -3,
      allocationInterval: 0,
    });
    assert.equal(s.decisionSource, "rules", "非法来源应退回量化交易");
    assert.ok(s.fastWindow >= 2, `快线窗口至少 2，实际 ${s.fastWindow}`);
    assert.ok(s.slowWindow >= 3, `慢线窗口至少 3，实际 ${s.slowWindow}`);
    assert.ok(s.maxTargetWeight <= 1);
    assert.equal(s.hybridInfluence, 0);
    assert.ok(s.allocationInterval >= 1);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("策略列表：默认参数是实测平台 2/8（改动必须同步文档与胜率下限用例）", () => {
  const d = dir();
  try {
    const store = new StrategyStore(d);
    const s = store.create({ name: "新策略" });
    // 这两个数字不是随手的「经典 5/20」：见 docs/architecture.md「设计取舍 · 默认策略参数」，
    // 它是多情景胜率扫网格测出来的平台中值；功能下限由 test/winRate.test.ts 的同名用例锁住。
    assert.equal(s.fastWindow, 2);
    assert.equal(s.slowWindow, 8);
    assert.ok(s.fastWindow < s.slowWindow);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("策略列表：引用同一策略的两个机器人，改策略两边同时生效", () => {
  const d = dir();
  try {
    const connections = new ConnectionManager(d);
    const conn = connections.create({ adapterId: "simulated", label: "模拟" });
    const strategies = new StrategyStore(d);
    const bots = new BotManager(d, testConfig(), connections, new LlmManager(d), strategies);

    const shared = strategies.create({ name: "共用策略", fastWindow: 7, slowWindow: 30, maxTargetWeight: 0.6 });
    const a = bots.create({ name: "A", connectionId: conn.id, symbols: ["单边上行"], strategyId: shared.id });
    const b = bots.create({ name: "B", connectionId: conn.id, symbols: ["震荡整理"], strategyId: shared.id });
    assert.equal(a.strategyId, shared.id);
    assert.equal(b.strategyId, shared.id);

    // 改一次策略，两个机器人读到的都是新值
    strategies.update(shared.id, { fastWindow: 11, slowWindow: 44 });
    assert.equal(bots.strategyOf(bots.get(a.id)!).fastWindow, 11);
    assert.equal(bots.strategyOf(bots.get(b.id)!).slowWindow, 44);

    // 给它们各自不同的策略：互不影响
    const solo = strategies.create({ name: "B 专用", fastWindow: 2, slowWindow: 60 });
    bots.update(b.id, { strategyId: solo.id });
    assert.equal(bots.strategyOf(bots.get(b.id)!).fastWindow, 2);
    assert.equal(bots.strategyOf(bots.get(a.id)!).fastWindow, 11, "A 不该被 B 的改动带偏");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("策略列表：引用失效时退回默认策略，而不是让机器人起不来", () => {
  const d = dir();
  try {
    const connections = new ConnectionManager(d);
    const conn = connections.create({ adapterId: "simulated", label: "模拟" });
    const strategies = new StrategyStore(d);
    const bots = new BotManager(d, testConfig(), connections, new LlmManager(d), strategies);

    const s = strategies.create({ name: "会被删掉的", fastWindow: 9, slowWindow: 40 });
    const bot = bots.create({ name: "A", connectionId: conn.id, symbols: ["单边上行"], strategyId: s.id });
    strategies.remove(s.id);

    const resolved = bots.strategyOf(bots.get(bot.id)!);
    assert.equal(resolved.id, strategies.default().id, "策略没了应退回默认策略");
    assert.equal(resolved.id !== s.id, true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("策略列表：老机器人（内联参数、无 strategyId）迁移后不丢决策来源", () => {
  const d = dir();
  try {
    const connections = new ConnectionManager(d);
    const conn = connections.create({ adapterId: "simulated", label: "模拟" });
    // 造一份旧格式 bots.json：策略参数内联，且用的是对话模型
    const legacy = [
      {
        id: "old0001",
        name: "老机器人",
        enabled: true,
        connectionId: conn.id,
        symbols: ["单边上行"],
        mode: "backtest",
        interval: "1m",
        barCount: 200,
        pollMs: 15000,
        decisionSource: "chat",
        modelProfileIds: [],
        decisionInterval: 10,
        strategy: {
          fastWindow: 3,
          slowWindow: 9,
          maxTargetWeight: 0.9,
          selfAllocating: true,
          maxPositions: 2,
          maxGrossExposure: 0.8,
          allocationInterval: 7,
          hybridInfluence: 0.4,
        },
        risk: { initialCash: 1000, maxPositionWeight: 0.5, maxOrderValue: 1000, maxDrawdownPct: 0.2, minTradeValue: 0 },
        createdAt: new Date().toISOString(),
      },
    ];
    writeFileSync(join(d, "bots.json"), JSON.stringify(legacy, null, 2), { mode: 0o600 });

    const strategies = new StrategyStore(d);
    const bots = new BotManager(d, testConfig(), connections, new LlmManager(d), strategies);
    const migrated = bots.get("old0001") as BotConfig;
    assert.ok(migrated.strategyId, "迁移后应有 strategyId");
    const profile = strategies.get(migrated.strategyId!)!;
    assert.ok(profile, "迁移出的策略应真实存在");
    assert.equal(profile.decisionSource, "chat", "决策来源必须迁移过去（漏了会被悄悄降级成量化交易）");
    assert.equal(profile.fastWindow, 3);
    assert.equal(profile.maxTargetWeight, 0.9);
    assert.equal(profile.selfAllocating, true);
    assert.equal(profile.allocationInterval, 7);
    assert.equal(migrated.decisionSource, "chat");

    // 迁移结果已落盘：再起一个管理器不会重复迁移
    const bots2 = new BotManager(d, testConfig(), connections, new LlmManager(d), new StrategyStore(d));
    assert.equal(bots2.get("old0001")!.strategyId, migrated.strategyId);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("策略列表：新建机器人未指定策略时，也会得到一条自己的策略（不会静默忽略参数）", () => {
  const d = dir();
  try {
    const connections = new ConnectionManager(d);
    const conn = connections.create({ adapterId: "simulated", label: "模拟" });
    const strategies = new StrategyStore(d);
    const bots = new BotManager(d, testConfig(), connections, new LlmManager(d), strategies);

    const before = strategies.list().length;
    const bot = bots.create({
      name: "临时策略",
      connectionId: conn.id,
      symbols: ["单边上行"],
      decisionSource: "systemone",
      strategy: { fastWindow: 12, slowWindow: 48 },
    });
    assert.equal(strategies.list().length, before + 1, "应新建一条策略");
    const p = strategies.get(bot.strategyId!)!;
    assert.equal(p.fastWindow, 12);
    assert.equal(p.slowWindow, 48);
    assert.equal(p.decisionSource, "systemone", "决策来源也要带过去");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});