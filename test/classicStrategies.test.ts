/** 突破 / 均值回归：状态机、方向与引擎装配。 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildPipeline } from "../src/agents/orchestrator.js";
import { BreakoutStrategy } from "../src/strategies/breakout.js";
import { MeanReversionStrategy } from "../src/strategies/meanReversion.js";
import { makeBars, testAdapter, testConfig } from "./helpers.js";

function ctx(closes: number[]) {
  return { symbol: "T", bars: makeBars(closes) };
}

test("唐奇安突破：突破前高做多，跌破短通道离场", async () => {
  const s = new BreakoutStrategy(10, 20, 0.5, false);
  const flat = Array(30).fill(100);
  assert.equal((await s.generate(ctx(flat)))?.targetWeight, 0, "区间内不交易");
  assert.ok((await s.generate(ctx([...flat, 110])))!.targetWeight > 0, "突破通道上沿应做多");
  assert.ok((await s.generate(ctx([...flat, 110, 111])))!.targetWeight > 0, "未触发离场应保持");
  assert.equal((await s.generate(ctx([...flat, 110, 90])))?.targetWeight, 0, "跌破短通道应离场");
});

test("唐奇安突破：合约可向下突破做空，现货不做空", async () => {
  const flat = Array(30).fill(100);
  const futures = new BreakoutStrategy(10, 20, 0.5, true);
  const spot = new BreakoutStrategy(10, 20, 0.5, false);
  assert.ok((await futures.generate(ctx([...flat, 90])))!.targetWeight < 0);
  assert.equal((await spot.generate(ctx([...flat, 90])))?.targetWeight, 0);
});

test("均值回归：跌到布林带下沿做多，回到均值附近离场", async () => {
  // trendMax 放宽，只验证布林带逻辑；真实默认会过滤强下跌
  const s = new MeanReversionStrategy(5, 20, 0.5, true, 1.5, 0.05);
  const flat = Array(25).fill(100);
  const long = await s.generate(ctx([...flat, 98]));
  assert.ok(long && long.targetWeight > 0, `下轨应做多，实际 ${long?.targetWeight}`);
  const back = await s.generate(ctx([...flat, 101, 100]));
  assert.equal(back?.targetWeight, 0, "回到均值附近不应继续持仓信号");
});

test("均值回归：合约可做空上轨，现货只能做多", async () => {
  const flat = Array(25).fill(100);
  const futures = new MeanReversionStrategy(5, 20, 0.5, true, 1.5, 0.05);
  const spot = new MeanReversionStrategy(5, 20, 0.5, false, 1.5, 0.05);
  assert.ok((await futures.generate(ctx([...flat, 103])))!.targetWeight < 0);
  assert.equal((await spot.generate(ctx([...flat, 103])))?.targetWeight, 0);
});

test("引擎装配：突破与均值回归都能被编排层选中", () => {
  for (const [engine, name] of [
    ["breakout", "donchian-breakout"],
    ["meanrev", "bollinger-meanrev"],
  ] as const) {
    const base = testConfig();
    const cfg = { ...base, strategy: { ...base.strategy, engine } };
    const pipeline = buildPipeline(cfg, { adapter: testAdapter(), liveTrading: false });
    assert.equal(pipeline.strategy.name, name);
  }
});
