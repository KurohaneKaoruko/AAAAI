/**
 * 历史模拟（回测）：整段历史一次性跑完，成交一次性全出。
 *
 * 与机器人的边界被测试锁住：机器人的统计只来自实时 K 线（见 bots.test.ts），
 * 这里才是那些"一启动就几十笔成交"该待的地方 —— 而且它不属于任何机器人。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBacktest } from "../src/backtest/runner.js";
import { StrategyStore } from "../src/strategies/profileStore.js";
import { testAdapter } from "./helpers.js";
import { testConfig } from "./helpers.js";

function setup(): { dir: string; strategies: StrategyStore } {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-bt-"));
  return { dir, strategies: new StrategyStore(dir) };
}

test("回测：整段历史一次跑完，成交一次性产出（这正是它该有的行为）", async () => {
  const { dir, strategies } = setup();
  try {
    const profile = strategies.create({ name: "双均线", fastWindow: 5, slowWindow: 20, maxTargetWeight: 0.5 });
    const result = await runBacktest(testConfig(), testAdapter(), profile, {
      symbols: ["DEMO-BTC"],
      interval: "1m",
      barCount: 120,
      strategyId: profile.id,
    });

    assert.equal(result.bars, 120, "应回放 120 根");
    assert.ok(result.metrics.totalFills > 0, `历史回放应产生成交，实际 ${result.metrics.totalFills} 笔`);
    assert.equal(result.trades.length, result.metrics.totalFills, "流水笔数应与指标一致（本次未截断）");
    assert.ok(result.equityCurve.length > 1, "应有权益曲线");
    assert.ok(result.pnlBySymbol.length > 0, "应有分标的盈亏");
    assert.equal(result.strategyName, "双均线");
    assert.ok(result.durationMs >= 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("回测：初始资金覆盖生效（用自己的钱，不受全局风控配置影响）", async () => {
  const { dir, strategies } = setup();
  try {
    const profile = strategies.create({ name: "双均线" });
    const result = await runBacktest(testConfig(), testAdapter(), profile, {
      symbols: ["DEMO-BTC"],
      barCount: 80,
      strategyId: profile.id,
      initialCash: 50_000,
    });
    assert.ok(result.metrics.finalEquity > 0);
    // 50k 的规模下成交金额应明显小于 100k 规模（否则资金覆盖没生效）
    const big = await runBacktest(testConfig(), testAdapter(), profile, {
      symbols: ["DEMO-BTC"],
      barCount: 80,
      strategyId: profile.id,
      initialCash: 400_000,
    });
    const avgQty = (r: typeof result) =>
      r.trades.reduce((a, t) => a + t.quantity * t.price, 0) / Math.max(1, r.trades.length);
    assert.ok(avgQty(big) > avgQty(result), "更大资金应下更大的单");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("回测：模型类策略被明确拒绝（回放里问模型等于用后见之明）", async () => {
  const { dir, strategies } = setup();
  try {
    for (const source of ["chat", "systemone", "hybrid"] as const) {
      const profile = strategies.create({ name: `模型策略 ${source}`, decisionSource: source });
      await assert.rejects(
        () =>
          runBacktest(testConfig(), testAdapter(), profile, {
            symbols: ["DEMO-BTC"],
            barCount: 60,
            strategyId: profile.id,
          }),
        /回测不支持|后见之明|模拟对照/,
        `${source} 类策略必须在回测里被拒绝，而不是偷偷用模型跑出一段虚高成绩`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("回测：取不到 K 线时明确报错（不留空结果让人误以为跑了但没赚）", async () => {
  const { dir, strategies } = setup();
  try {
    const profile = strategies.create({ name: "双均线" });
    const adapter = testAdapter();
    // 让适配器返回空：模拟标的不存在
    adapter.fetchKlines = async () => [];
    await assert.rejects(
      () =>
        runBacktest(testConfig(), adapter, profile, {
          symbols: ["不存在"],
          barCount: 60,
          strategyId: profile.id,
        }),
      /没有取到任何 K 线/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});