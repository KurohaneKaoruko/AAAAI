import assert from "node:assert/strict";
import test from "node:test";
import { MomentumStrategy } from "../src/strategies/momentum.js";
import { makeBars } from "./helpers.js";

test("MomentumStrategy: 预热不足返回 null", async () => {
  const s = new MomentumStrategy(5, 20);
  assert.equal(s.warmup, 20);
  assert.equal(await s.generate({ symbol: "T", bars: makeBars(Array(19).fill(100)) }), null);
});

test("MomentumStrategy: 上升趋势给出正权重", async () => {
  const s = new MomentumStrategy(5, 20, 0.5);
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i); // 单边上涨
  const signal = await s.generate({ symbol: "T", bars: makeBars(closes) });
  assert.ok(signal);
  assert.ok(signal.targetWeight > 0 && signal.targetWeight <= 0.5);
  assert.ok(signal.confidence > 0);
  assert.match(signal.reason, /fast_ma/);
});

test("MomentumStrategy: 下跌趋势权重为 0", async () => {
  const s = new MomentumStrategy(5, 20, 0.5);
  const closes = Array.from({ length: 30 }, (_, i) => 200 - i);
  const signal = await s.generate({ symbol: "T", bars: makeBars(closes) });
  assert.ok(signal);
  assert.equal(signal.targetWeight, 0);
});

test("MomentumStrategy: fast >= slow 报错", () => {
  assert.throws(() => new MomentumStrategy(20, 20));
  assert.throws(() => new MomentumStrategy(30, 20));
});
