/**
 * LLM 决策策略的两条底线：
 * 1. 模型决策必须持有到下一次决策（决策间隔的语义），非决策根不能被
 *    动量基线顶掉 —— 否则模型选手的成绩会退化成基线；
 * 2. 合约模式允许负权重（做空），现货仍然只能 0~1。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { LLMStrategy } from "../src/strategies/llmStrategy.js";
import { parseDecision, type LLMClient } from "../src/llm/llmClient.js";
import type { Strategy, StrategyContext } from "../src/strategies/strategy.js";
import type { Signal } from "../src/core/types.js";
import { makeBars } from "./helpers.js";

const BASELINE_WEIGHT = 0.4;

/** 固定输出的基线策略：模型没接手时应该看到它。 */
const baseline: Strategy = {
  name: "baseline",
  warmup: 1,
  generate: async (ctx: StrategyContext): Promise<Signal> => ({
    symbol: ctx.symbol,
    timestamp: ctx.bars[ctx.bars.length - 1]!.timestamp,
    targetWeight: BASELINE_WEIGHT,
    confidence: 0.5,
    reason: "baseline",
  }),
};

function ctxAt(len: number): StrategyContext {
  const bars = makeBars(Array.from({ length: len }, (_, i) => 100 + i * 0.1));
  return { symbol: "TEST", bars };
}

function fakeClient(reply: (call: number) => string): { client: LLMClient; calls: () => number } {
  let n = 0;
  return {
    client: {
      name: "fake",
      complete: async () => {
        n += 1;
        return reply(n);
      },
    },
    calls: () => n,
  };
}

test("LLM 决策在非决策根持有，不被动量基线覆盖", async () => {
  const { client, calls } = fakeClient(() => '{"target_weight":0.8,"confidence":0.9,"reason":"看多"}');
  const s = new LLMStrategy(baseline, client, 5, async () => []);
  const out = (n: number) => s.generate(ctxAt(n));
  const outWithCtx = async (n: number) => {
    const c = ctxAt(n);
    return { r: await s.generate(c), c };
  };

  // 第一次决策前：没有模型判断，用基线兜底
  assert.equal((await out(1))!.targetWeight, BASELINE_WEIGHT);
  assert.equal((await out(4))!.targetWeight, BASELINE_WEIGHT);
  // 第 5 根：请求模型
  const d1 = await out(5);
  assert.equal(d1!.targetWeight, 0.8);
  assert.match(d1!.reason, /^\[llm\]/);
  // 第 6~9 根：模型决策必须还在（以前这里会变成 0.4）
  for (const n of [6, 7, 8, 9]) {
    const { r, c } = await outWithCtx(n);
    assert.equal(r!.targetWeight, 0.8, `第 ${n} 根不应被基线覆盖`);
    assert.match(r!.reason, /^\[llm\]/);
    // 持有信号要换上当前 K 线的时间戳（否则下游会以为是旧信号）
    assert.equal(r!.timestamp.getTime(), c.bars[n - 1]!.timestamp.getTime());
  }
  // 第 10 根：第二次请求，仍按模型输出
  assert.equal((await out(10))!.targetWeight, 0.8);
  assert.equal(calls(), 2, "决策间隔内只应请求 2 次模型");
});

test("模型临时失败：沿用上一笔判断；从未成功过才回退基线", async () => {
  // 第一次成功，之后全部失败
  const flaky = fakeClient((n) =>
    n === 1 ? '{"target_weight":0.7,"confidence":0.8,"reason":"持有"}' : (() => { throw new Error("HTTP 524"); })(),
  );
  const s = new LLMStrategy(baseline, flaky.client, 5, async () => []);
  assert.equal((await s.generate(ctxAt(5)))!.targetWeight, 0.7);
  // 第 6~9 根：持有（不请求）
  assert.equal((await s.generate(ctxAt(6)))!.targetWeight, 0.7);
  // 第 10 根：请求失败，沿用上一笔 0.7，并标记 stale
  const stale = await s.generate(ctxAt(10));
  assert.equal(stale!.targetWeight, 0.7, "失败不应把模型仓位换成基线");
  assert.match(stale!.reason, /^\[llm-stale\]/);
  // 第 15 根：继续沿用
  assert.equal((await s.generate(ctxAt(15)))!.targetWeight, 0.7);

  // 冷启动就失败：没有历史判断，只能回退基线
  const dead = fakeClient(() => { throw new Error("未配置密钥"); });
  const cold = new LLMStrategy(baseline, dead.client, 5, async () => []);
  const fb = await cold.generate(ctxAt(5));
  assert.equal(fb!.targetWeight, BASELINE_WEIGHT);
  assert.match(fb!.reason, /^\[fallback\]/);
});

test("合约模式允许负权重做空，现货仍钳在 0~1", async () => {
  let prompt = "";
  const client: LLMClient = {
    name: "fake",
    complete: async (p) => {
      prompt = p;
      return '{"target_weight":-0.6,"confidence":0.7,"reason":"看空"}';
    },
  };

  const futures = new LLMStrategy(baseline, client, 5, async () => [], undefined, undefined, 0, true);
  const short = await futures.generate(ctxAt(5));
  assert.equal(short!.targetWeight, -0.6, "合约模式应保留负权重");
  assert.match(prompt, /-1\.0~1\.0/);
  assert.match(prompt, /做空/);

  const spot = new LLMStrategy(baseline, client, 5, async () => []);
  const spotSignal = await spot.generate(ctxAt(5));
  assert.equal(spotSignal!.targetWeight, 0, "现货看空应空仓，而不是回退基线持有多头");
  assert.match(spotSignal!.reason, /^\[llm\]/);
  assert.match(prompt, /0\.0~1\.0/);

  // 解析层：现货负值一律钳 0（合法看空表达）；合约放行 -1~1
  assert.equal(parseDecision('{"target_weight":-0.6}').targetWeight, 0);
  assert.equal(parseDecision('{"target_weight":-0.1}').targetWeight, 0);
  assert.equal(parseDecision('{"target_weight":-0.6}', { minWeight: -1 }).targetWeight, -0.6);
  assert.throws(() => parseDecision('{"target_weight":-1.2}', { minWeight: -1 }), /target_weight 非法/);
});
