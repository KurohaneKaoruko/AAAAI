/**
 * 自我进化：从决策结果里学习，并安全地改参数。
 *
 * 这里锁住几条不可退让的红线：
 * - 默认关闭：开关没开，记录与调参都不发生；
 * - 样本不足不动手、变更之间要冷却、单次变动有幅度上限；
 * - 只碰白名单里的搜索参数，回撤熔断等风控参数永不被自动放宽；
 * - 每次变更都有理由与依据，可回滚。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvolutionEngine } from "../src/evolution/engine.js";
import { proposeTuning, type EvolutionStats } from "../src/evolution/types.js";
import { testConfig } from "./helpers.js";
import type { AppConfig } from "../src/configSchema.js";

function enabledConfig(overrides: Partial<AppConfig["evolution"]> = {}): AppConfig {
  const base = testConfig();
  return {
    ...base,
    evolution: {
      ...base.evolution,
      enabled: true,
      minSamples: 5,
      cooldownMs: 0,
      evaluateMs: 60_000,
      maxChangeRatio: 0.2,
      horizonBars: 1,
      // 默认 true：落盘相关用例需要它；「不落盘」用例会显式传 false
      persist: true,
      tunable: ["strategy.maxTargetWeight", "strategy.fastWindow", "risk.minTradeValue"],
      ...overrides,
    },
  };
}

function engine(dir: string, config: AppConfig): { evo: EvolutionEngine; latest: () => AppConfig } {
  let current = config;
  const evo = new EvolutionEngine(dir, current, (next) => {
    current = next;
  });
  return { evo, latest: () => current };
}

/** 造一段行情：symbol -> 收盘价序列 */
function series(symbol: string, values: number[]): Map<string, number[]> {
  return new Map([[symbol, values]]);
}

test("进化：默认关闭时不记录也不调参", () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-evo-"));
  try {
    const base = testConfig();
    const config: AppConfig = { ...base, evolution: { ...base.evolution, enabled: false } };
    const { evo } = engine(dir, config);
    evo.record({ owner: "engine", source: "rules", weights: { A: 0.5 }, cashWeight: 0.5, confidence: 0.5, reason: "r", refPrices: { A: 10 } });
    assert.equal(evo.stats().total, 0, "关闭时不该有记录");
    assert.deepEqual(evo.evaluate(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("进化：决策在 horizon 后结算，算出收益与相对空仓的超额", () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-evo-"));
  try {
    const { evo } = engine(dir, enabledConfig({ horizonBars: 3 }));
    evo.record({
      owner: "engine",
      source: "hybrid",
      weights: { A: 0.5 },
      cashWeight: 0.5,
      confidence: 0.7,
      reason: "看多",
      refPrices: { A: 100 },
      entryBarIndex: 0,
    });
    // horizon=3，但只推进了 2 根 -> 还没到期
    evo.settle(series("A", [100, 101, 102, 110, 120]), { advanceBars: 2, equalWeight: 0 });
    assert.equal(evo.stats().settled, 0);
    // 推进到第 3 根之后才结算：100 -> 110，权重 0.5 -> +5%
    evo.settle(series("A", [100, 101, 102, 110, 120]), { advanceBars: 3, equalWeight: 0 });
    const rec = evo.view().recentDecisions[0]!;
    assert.ok(rec.outcome, "应已结算");
    assert.ok(Math.abs(rec.outcome!.returnPct - 0.05) < 1e-6, `实际 ${rec.outcome!.returnPct}`);
    assert.ok(rec.outcome!.maxAdverse <= 0, "全程上涨时最大不利偏移不应为正");
    assert.equal(evo.stats().settled, 1);
    assert.equal(evo.stats().pending, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("进化：相对等权基准算超额（alpha）", () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-evo-"));
  try {
    const { evo } = engine(dir, enabledConfig());
    evo.record({
      owner: "engine",
      source: "rules",
      weights: { A: 0.5 },
      cashWeight: 0.5,
      confidence: 0.5,
      reason: "r",
      refPrices: { A: 100 },
      entryBarIndex: 0,
    });
    // A 涨 20%，等权基准 +10%
    evo.settle(series("A", [100, 120]), { advanceBars: 1, equalWeight: 0.1 });
    const out = evo.view().recentDecisions[0]!.outcome!;
    assert.ok(Math.abs(out.returnPct - 0.1) < 1e-6, `组合收益应为 0.5*20%=${out.returnPct}`);
    assert.ok(Math.abs(out.alpha - 0) < 1e-6, `超额应为 0.1-0.1=0，实际 ${out.alpha}`);
    assert.equal(evo.stats().beatRate, 0, "超额为 0 不算跑赢");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("进化：样本不足不动手", () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-evo-"));
  try {
    const { evo } = engine(dir, enabledConfig({ minSamples: 5 }));
    for (let i = 0; i < 3; i++) {
      evo.record({ owner: "engine", source: "rules", weights: { A: 0.5 }, cashWeight: 0.5, confidence: 0.5, reason: "r", refPrices: { A: 100 }, entryBarIndex: 0 });
      evo.settle(series("A", [100, 90]), { advanceBars: 1, equalWeight: 0 });
    }
    assert.equal(evo.stats().settled, 3);
    assert.deepEqual(evo.evaluate(), [], "样本 3 < 5，不该调参");
    assert.equal(evo.stats().samplesNeeded, 2);
    // force 时可以手动触发
    assert.ok(evo.evaluate(true).length > 0, "手动评估应生效");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("进化：跑输空仓 -> 收缩仓位；跑赢 -> 小步放开但不超过风控上限", () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-evo-"));
  try {
    const base = enabledConfig();
    const before = base.strategy.maxTargetWeight;

    // 长期跑输
    const loser: EvolutionStats = {
      total: 30, settled: 30, pending: 0, winRate: 0.3, avgReturn: -0.01, avgAlpha: -0.02,
      beatRate: 0.1, bestSymbol: null, bestSymbolAlpha: 0, lastEvaluatedAt: null, cooldownUntil: null, samplesNeeded: 0,
    };
    const shrink = proposeTuning(loser, base, { tunable: ["strategy.maxTargetWeight"], maxChangeRatio: 0.2 });
    assert.equal(shrink.length, 1);
    assert.equal(shrink[0]!.param, "strategy.maxTargetWeight");
    assert.ok(shrink[0]!.value < before, "应收缩目标仓上限");
    assert.ok(Math.abs(shrink[0]!.value - before * 0.8) < 1e-6, "单次收缩不超过 maxChangeRatio");

    // 长期跑赢：放开但不超过 risk.maxPositionWeight
    const tight = { ...base, risk: { ...base.risk, maxPositionWeight: 0.55 } };
    const winner: EvolutionStats = { ...loser, avgAlpha: 0.02, beatRate: 0.7, winRate: 0.7 };
    const grow = proposeTuning(winner, tight, { tunable: ["strategy.maxTargetWeight"], maxChangeRatio: 0.5 });
    assert.equal(grow.length, 1);
    assert.ok(grow[0]!.value > tight.strategy.maxTargetWeight);
    assert.ok(grow[0]!.value <= tight.risk.maxPositionWeight + 1e-9, "不得突破风控单标的上限");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("进化：变更写入日志、作用于配置，并能一键回滚", () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-evo-"));
  try {
    const config = enabledConfig({ minSamples: 1 });
    const { evo, latest } = engine(dir, config);
    const before = config.strategy.maxTargetWeight;
    for (let i = 0; i < 4; i++) {
      evo.record({ owner: "engine", source: "rules", weights: { A: 0.5 }, cashWeight: 0.5, confidence: 0.5, reason: "r", refPrices: { A: 100 }, entryBarIndex: 0 });
      evo.settle(series("A", [100, 80]), { advanceBars: 1, equalWeight: 0 });
    }
    const applied = evo.evaluate();
    assert.ok(applied.length > 0, "应产生变更");
    const changed = latest().strategy.maxTargetWeight;
    assert.ok(changed < before, "配置应被收紧");
    assert.ok(latest().risk.minTradeValue > config.risk.minTradeValue, "噪声调仓门槛也应被抬高");

    const view = evo.view();
    assert.ok(view.changelog.length > 0);
    assert.match(view.changelog[0]!.reason, /跑输|超额/);
    assert.equal(view.changelog[0]!.reverted, false);

    const reverted = evo.rollback();
    assert.ok(reverted && reverted.length > 0, "应能回滚");
    assert.ok(reverted.every((r) => r.reverted));
    assert.equal(latest().strategy.maxTargetWeight, before, "回滚后应恢复原值");
    assert.equal(evo.view().changelog[0]!.reverted, true);
    assert.equal(evo.rollback(), null, "已回滚的不再重复回滚");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("进化：白名单外的参数永不自动调整", () => {
  const base = enabledConfig();
  const stats: EvolutionStats = {
    total: 50, settled: 50, pending: 0, winRate: 0.1, avgReturn: -0.05, avgAlpha: -0.05,
    beatRate: 0, bestSymbol: null, bestSymbolAlpha: 0, lastEvaluatedAt: null, cooldownUntil: null, samplesNeeded: 0,
  };
  const proposals = proposeTuning(stats, base, {
    tunable: ["strategy.maxTargetWeight", "risk.minTradeValue", "strategy.fastWindow"],
    maxChangeRatio: 0.2,
  });
  const keys = proposals.map((p) => p.param);
  assert.ok(keys.every((k) => k.startsWith("strategy.") || k === "risk.minTradeValue"), `越界参数: ${keys}`);
  assert.ok(!keys.includes("risk.maxDrawdownPct"), "回撤熔断不可自动调整");
  assert.ok(!keys.includes("risk.maxOrderValue"), "单笔上限不可自动调整");
  assert.ok(!keys.includes("risk.maxPositionWeight"), "风控仓位上限不可自动调整");
});

test("进化：学习记录落盘，重启后不丢", () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-evo-"));
  try {
    const config = enabledConfig();
    const first = engine(dir, config).evo;
    first.record({ owner: "engine", source: "rules", weights: { A: 0.5 }, cashWeight: 0.5, confidence: 0.5, reason: "r", refPrices: { A: 100 }, entryBarIndex: 0 });
    first.settle(series("A", [100, 105]), { advanceBars: 1, equalWeight: 0 });
    first.evaluate(true);

    const second = engine(dir, config).evo;
    const view = second.view();
    assert.equal(view.stats.total, 1);
    assert.equal(view.stats.settled, 1);
    assert.ok(view.changelog.length > 0, "变更日志也应保留");
    assert.equal(view.recentDecisions[0]!.outcome!.returnPct, 0.025);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("进化：改配置后引擎用的是新值（回归：曾只替换对象不深合并）", () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-evo-"));
  try {
    const config = enabledConfig({ minSamples: 20 });
    const { evo } = engine(dir, config);
    // 模拟 applyConfig 的深合并：只带 enabled 一个字段
    const next: AppConfig = { ...config, evolution: { ...config.evolution, enabled: false } };
    evo.useConfig(next);
    assert.equal(evo.evolution.enabled, false);
    assert.equal(evo.evolution.minSamples, 20, "未提交的字段应保持原值，而不是被 undefined 覆盖");
    assert.equal(evo.evolution.maxChangeRatio, config.evolution.maxChangeRatio);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("进化：persist=false 真的不落盘（不是只影响展示）", () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-evo-nopersist-"));
  try {
    const base = testConfig();
    const config: AppConfig = {
      ...base,
      evolution: {
        ...base.evolution,
        enabled: true,
        persist: false,
        minSamples: 5,
        cooldownMs: 0,
        evaluateMs: 60_000,
        horizonBars: 1,
        tunable: ["strategy.maxTargetWeight"],
      },
    };
    const { evo } = engine(dir, config);
    evo.record({ owner: "engine", source: "rules", weights: { A: 0.5 }, cashWeight: 0.5, confidence: 0.5, reason: "r", refPrices: { A: 10 } });
    evo.record({ owner: "engine", source: "rules", weights: { A: 0.4 }, cashWeight: 0.6, confidence: 0.5, reason: "r", refPrices: { A: 10 } });
    // 内存里确实记了
    assert.ok(evo.stats().total >= 2, "内存中应记录了决策");
    // 但磁盘上不能有任何文件
    assert.equal(
      existsSync(join(dir, "evolution.json")),
      false,
      "persist=false 时不得写 evolution.json（这个开关曾经完全不挡写入）",
    );

    // 对照：persist=true 时必须落盘，否则上面那条断言就没意义
    const dir2 = mkdtempSync(join(tmpdir(), "aaaaai-evo-persist-"));
    try {
      const on: AppConfig = { ...config, evolution: { ...config.evolution, persist: true } };
      const { evo: evo2 } = engine(dir2, on);
      evo2.record({ owner: "engine", source: "rules", weights: { A: 0.5 }, cashWeight: 0.5, confidence: 0.5, reason: "r", refPrices: { A: 10 } });
      assert.ok(existsSync(join(dir2, "evolution.json")), "persist=true 时应落盘");
      const saved = JSON.parse(readFileSync(join(dir2, "evolution.json"), "utf8")) as { records: unknown[] };
      assert.ok(Array.isArray(saved.records) && saved.records.length >= 1);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
