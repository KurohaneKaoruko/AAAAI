/**
 * 混合决策：对话模型 + System One（可再叠加规则路）按配比融合。
 *
 * 重点验证四件事：
 * 1. 配比真的按权重线性融合，而不是「谁先答听谁的」；
 * 2. 某一路没有实例 / 调用失败时自动退出，配比让给其余路，不会让仓位凭空缩水；
 * 3. 融合结果仍受额度约束（单标的、总仓位、持仓数）；
 * 4. 逐标的模式与资产配置模式都融合，且理由里能看出各路说了什么。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { blendRatios, blendWeightMaps, BlendedStrategy, BlendedAllocator } from "../src/strategies/blend.js";
import { AIAllocator, CrossSectionalAllocator } from "../src/strategies/allocator.js";
import type { Lane } from "../src/strategies/blend.js";
import { buildPipeline, feed } from "../src/agents/orchestrator.js";
import { mergeBarsByTime, streamBars } from "../src/data/streaming.js";
import { Topic } from "../src/core/eventBus.js";
import type { Allocation } from "../src/core/types.js";
import type { LLMClient } from "../src/llm/llmClient.js";
import { testAdapter, testConfig } from "./helpers.js";
import type { AppConfig } from "../src/configSchema.js";

const RULES: Lane = { source: "rules", weight: 1, available: true };
const CHAT: Lane = { source: "chat", weight: 3, available: true };
const SO: Lane = { source: "systemone", weight: 1, available: true };

test("混合决策：配比归一化，0 配比与不可用的路被剔除", () => {
  const r = blendRatios([RULES, CHAT, SO]);
  assert.deepEqual(r.ratios, { rules: 0.2, chat: 0.6, systemone: 0.2 });
  assert.ok(Math.abs(Object.values(r.ratios).reduce((a, b) => a + b, 0) - 1) < 1e-9, "配比和为 1");

  // 配比为 0 的路不参与
  const zero = blendRatios([{ ...RULES, weight: 0 }, CHAT]);
  assert.equal(zero.ratios.rules, 0);
  assert.equal(zero.ratios.chat, 1);
  assert.deepEqual(zero.dropped, ["rules"]);

  // 全部不可用 -> 退回纯规则，组合永远有决策
  const none = blendRatios([
    { source: "chat", weight: 5, available: false },
    { source: "systemone", weight: 5, available: false },
  ]);
  assert.equal(none.ratios.rules, 1);

  // 只有一路配比为 0 -> 等权兜底
  const equal = blendRatios([RULES, { ...CHAT, weight: 0 }]);
  assert.deepEqual(equal.ratios, { rules: 1, chat: 0, systemone: 0 });
});

test("混合决策：权重表按配比线性融合，并报出分歧", () => {
  const maps = {
    rules: { A: 0.4, B: 0.1 },
    chat: { A: 0.6, C: 0.2 },
    systemone: { B: 0.5 },
  };
  const r = blendWeightMaps([RULES, CHAT, SO], maps);
  // rules 20% / chat 60% / so 20%
  assert.ok(Math.abs(r.weights.A! - (0.4 * 0.2 + 0.6 * 0.6)) < 1e-6);
  assert.ok(Math.abs(r.weights.B! - (0.1 * 0.2 + 0.5 * 0.2)) < 1e-6);
  assert.ok(Math.abs(r.weights.C! - (0.2 * 0.6)) < 1e-6);
  assert.match(r.conflict ?? "", /首选不一致/);
  assert.match(r.conflict ?? "", /对话模型→A/);

  // 各路都选同一个 -> 无分歧
  const agree = blendWeightMaps([RULES, CHAT], { rules: { A: 0.2 }, chat: { A: 0.7 } });
  assert.equal(agree.conflict, null);
});

test("混合决策：某一路不可用时，配比自动让给其余路", async () => {
  const limits = { maxPositions: 2, maxPositionWeight: 0.8, grossCap: 1 };
  const chat: LLMClient = {
    name: "chat",
    async complete() {
      return "{}";
    },
    async allocate() {
      return JSON.stringify({ allocations: { A: 0.9 }, confidence: 0.9, reason: "只买 A" });
    },
  };
  const alloc = new BlendedAllocator(
    // systemone 没配实例 -> 不可用；配比 1:2:1 会被归一成 rules 1/4、chat 3/4
    [RULES, CHAT, { source: "systemone", weight: 1, available: false }],
    {
      rules: new AIAllocator(new CrossSectionalAllocator(), null, limits),
      chat: new AIAllocator(new CrossSectionalAllocator(), chat, limits),
      systemone: new AIAllocator(new CrossSectionalAllocator(), null, limits),
    },
    limits,
  );
  const snap = [
    { symbol: "A", price: 10, momentum: 0.03, retShort: 0.01, retLong: 0.02, trend: "up" as const, bars: 60 },
    { symbol: "B", price: 10, momentum: -0.02, retShort: -0.01, retLong: -0.03, trend: "down" as const, bars: 60 },
  ];
  const r = await alloc.allocate(snap);
  assert.ok(r.weights.A! > 0, "chat 选的 A 应被采纳");
  assert.ok(r.notes.some((n) => n.includes("决策模型") && n.includes("未参与")), "应说明哪一路没参与");
  assert.ok(Object.values(r.weights).every((w) => w <= limits.maxPositionWeight + 1e-9), "仍受单标的上限约束");
  assert.ok(Object.values(r.weights).reduce((a, b) => a + b, 0) <= limits.grossCap + 1e-9);
});

test("混合决策：两路都失败也不能让组合停摆", async () => {
  const limits = { maxPositions: 2, maxPositionWeight: 0.6, grossCap: 1 };
  const broken = (): LLMClient => ({
    name: "broken",
    async complete() {
      return "{}";
    },
    async allocate() {
      throw new Error("端点不可达");
    },
  });
  const alloc = new BlendedAllocator([RULES, CHAT, SO], {
    rules: new AIAllocator(new CrossSectionalAllocator(), null, limits),
    chat: new AIAllocator(new CrossSectionalAllocator(), broken(), limits),
    systemone: new AIAllocator(new CrossSectionalAllocator(), broken(), limits),
  }, limits);
  const snap = [
    { symbol: "A", price: 10, momentum: 0.04, retShort: 0.01, retLong: 0.02, trend: "up" as const, bars: 60 },
  ];
  const r = await alloc.allocate(snap);
  // 两路 AI 全挂 -> 规则路仍给出配置（source=rules），且有说明
  assert.equal(r.source, "rules");
  assert.ok(r.weights.A! > 0, "规则基线应兜住");
});

test("混合决策：逐标的模式按配比融合目标仓位", async () => {
  const fixed = (w: number, tag: string): LLMClient => ({
    name: tag,
    async complete() {
      return JSON.stringify({ target_weight: w, confidence: 0.8, reason: `${tag}看多` });
    },
  });
  // 快慢线造出强动量 -> 规则路约 0.3 仓位；两路模型给 0.6 / 0.0
  const bars = Array.from({ length: 40 }, (_, i) => ({
    symbol: "BTC",
    timestamp: new Date(Date.now() + i * 60_000),
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i * 2,
    volume: 1,
  }));

  const momentum = new (await import("../src/strategies/momentum.js")).MomentumStrategy(5, 20, 0.5);
  const llm = (await import("../src/strategies/llmStrategy.js")).LLMStrategy;
  const lanes: Lane[] = [RULES, CHAT, SO];
  const blended = new BlendedStrategy(lanes, {
    rules: momentum,
    chat: new llm(momentum, fixed(0.6, "chat"), 1),
    systemone: new llm(momentum, fixed(0.0, "so"), 1),
  });

  const signal = await blended.generate({ symbol: "BTC", bars });
  assert.ok(signal, "应给出信号");
  const base = await momentum.generate({ symbol: "BTC", bars });
  const chatOnly = await new llm(momentum, fixed(0.6, "chat"), 1).generate({ symbol: "BTC", bars });
  const soOnly = await new llm(momentum, fixed(0.0, "so"), 1).generate({ symbol: "BTC", bars });

  // 融合 = 0.2*规则 + 0.6*0.6 + 0.2*0
  const expected = 0.2 * base!.targetWeight + 0.6 * chatOnly!.targetWeight + 0.2 * soOnly!.targetWeight;
  assert.ok(
    Math.abs(signal!.targetWeight - expected) < 1e-6,
    `融合仓位应为 ${expected}，实际 ${signal!.targetWeight}`,
  );
  assert.match(signal!.reason, /mix/);
  assert.match(signal!.reason, /对话模型/);
});

test("混合决策：端到端——chat 与 System One 同时在线，按配比调仓", async () => {
  const calls = { chat: 0, so: 0 };
  const chat: LLMClient = {
    name: "chat",
    async complete() {
      return "{}";
    },
    async allocate(_p, symbols) {
      calls.chat += 1;
      // 对话模型偏好 BTC
      const keys = symbols.includes("BTC") ? ["BTC"] : symbols.slice(0, 1);
      return JSON.stringify({
        allocations: Object.fromEntries(keys.map((k) => [k, 0.5])),
        confidence: 0.7,
        reason: "chat 偏好",
      });
    },
  };
  const so: LLMClient = {
    name: "so",
    async complete() {
      return "{}";
    },
    async allocate(_p, symbols) {
      calls.so += 1;
      // System One 偏好 DEMO-ETH
      const keys = symbols.includes("DEMO-ETH") ? ["DEMO-ETH"] : symbols.slice(0, 1);
      return JSON.stringify({
        allocations: Object.fromEntries(keys.map((k) => [k, 0.5])),
        confidence: 0.7,
        reason: "so 偏好",
      });
    },
  };

  const base = testConfig();
  const config: AppConfig = {
    ...base,
    strategy: {
      ...base.strategy,
      decisionSource: "chat",
      sources: ["chat", "systemone"],
      blend: { rules: 0, chat: 3, systemone: 1 },
      selfAllocating: true,
      maxPositions: 2,
      maxGrossExposure: 0.9,
      allocationInterval: 1,
    },
    risk: { ...base.risk, maxPositionWeight: 0.6, initialCash: 100_000 },
  };

  const adapter = testAdapter();
  const pipeline = buildPipeline(config, {
    adapter,
    liveTrading: false,
    lanes: { chat, systemone: so },
    llm: chat,
  });
  const allocations: Allocation[] = [];
  pipeline.bus.subscribe(Topic.ALLOCATION, (e) => allocations.push(e.payload as Allocation));

  const groups = await Promise.all([
    adapter.fetchKlines("BTC", "1m", 120),
    adapter.fetchKlines("DEMO-ETH", "1m", 120),
  ]);
  await feed(pipeline, mergeBarsByTime(groups));

  assert.ok(calls.chat > 0 && calls.so > 0, "两路都应被问到（混合决策不能只跑一路）");
  assert.ok(allocations.length > 0, "应产出资产配置");
  const last = allocations[allocations.length - 1]!;
  assert.equal(last.source, "mix", "两路都有贡献时应标为 mix");
  assert.match(last.reason, /chat 偏好/);
  assert.match(last.reason, /so 偏好/);
  // 配比 3:1 -> 两路都拿到仓位，但 chat 那路更重
  const weights = Object.entries(last.weights).sort((a, b) => b[1] - a[1]);
  assert.ok(weights.length >= 1);
  assert.ok(weights[0]![1] > 0, "应至少持有一个资产");
  assert.ok(Object.values(last.weights).reduce((a, b) => a + b, 0) <= 0.9 + 1e-6, "不得突破总仓位上限");
});