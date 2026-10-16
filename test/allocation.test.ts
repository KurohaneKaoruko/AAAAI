/** AI 自主选资产（资产配置）：解析、裁剪、规则基线、AI 决策与端到端落地。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeAllocation,
  normalizeAllocation,
  parseAllocation,
  buildAllocationPrompt,
  type AllocationLimits,
  type AssetSnapshot,
} from "../src/llm/allocation.js";
import { AIAllocator, CrossSectionalAllocator } from "../src/strategies/allocator.js";
import { buildPipeline } from "../src/agents/orchestrator.js";
import { mergeBarsByTime, streamBars } from "../src/data/streaming.js";
import { Topic } from "../src/core/eventBus.js";
import type { Allocation, Signal } from "../src/core/types.js";
import type { LLMClient } from "../src/llm/llmClient.js";
import { testAdapter, testConfig } from "./helpers.js";

const LIMITS: AllocationLimits = { maxPositions: 2, maxPositionWeight: 0.5, grossCap: 1 };

function snap(symbol: string, momentum: number, extra: Partial<AssetSnapshot> = {}): AssetSnapshot {
  return {
    symbol,
    price: 100,
    momentum,
    retShort: 0.01,
    retLong: 0.02,
    trend: momentum > 0 ? "up" : "down",
    bars: 60,
    ...extra,
  };
}

test("资产配置：解析对象/数组/围栏/旧格式四种输出", () => {
  const a = parseAllocation('```json\n{"allocations": {"BTC": 0.5, "ETH": 0.2}, "cash_weight": 0.3, "confidence": 0.7, "reason": "强势"}\n```');
  assert.deepEqual(a.weights, { BTC: 0.5, ETH: 0.2 });
  assert.equal(a.cashWeight, 0.3);
  assert.equal(a.confidence, 0.7);

  const b = parseAllocation('{"allocations":[{"symbol":"BTC","weight":0.4},{"symbol":"ETH","weight":0.1}]}');
  assert.deepEqual(b.weights, { BTC: 0.4, ETH: 0.1 });
  assert.ok(Number.isNaN(b.cashWeight), "没给 cash_weight 时留 NaN，由裁剪结果为准");

  // 旧格式兜底
  const c = parseDecisionCompat();
  assert.deepEqual(c.weights, { BTC: 0.33 });
  // 无法解析时抛错（上层据此回退基线）
  assert.throws(() => parseAllocation("我觉得应该全仓 BTC"), /未找到 JSON/);
  assert.throws(() => parseAllocation('{"reason":"没给配置"}'), /没有可用的 allocations/);
});

function parseDecisionCompat() {
  return parseAllocation('{"symbol":"BTC","target_weight":0.33,"confidence":0.5}');
}

test("资产配置：裁剪规则（越界/超数/超总额/候选池外）", () => {
  const candidates = ["A", "B", "C"];
  const r = normalizeAllocation(
    {
      weights: { A: 0.9, B: 0.4, C: 0.3, "不存在": 0.5, D: -1 },
      cashWeight: 0,
      confidence: 0.5,
      reason: "x",
    },
    candidates,
    { maxPositions: 2, maxPositionWeight: 0.5, grossCap: 0.8 },
  );
  // A/B/C 排序后只留前两个；单标的上限 0.5；总和再压到 0.8
  assert.deepEqual(Object.keys(r.weights), ["A", "B"]);
  const sum = r.weights.A! + r.weights.B!;
  assert.ok(Math.abs(sum - 0.8) < 1e-6, `总仓位应为 0.8，实际 ${sum}`);
  assert.ok(r.weights.A! <= 0.5 + 1e-9 && r.weights.B! <= 0.5 + 1e-9, "单标的不得超上限");
  assert.ok(Math.abs(r.cashWeight - 0.2) < 1e-6, "剩余为现金");
  assert.ok(r.notes.some((n) => n.includes("不存在")), "应提示丢弃候选池外标的");
  assert.ok(r.notes.some((n) => n.includes("持仓上限")), "应提示超出持仓上限");
});

test("资产配置：规则基线只选动量为正的前 N 名", async () => {
  const base = new CrossSectionalAllocator(LIMITS);
  const r = await base.allocate([snap("A", 0.05), snap("B", 0.02), snap("C", -0.03)]);
  assert.equal(r.source, "rules");
  assert.ok((r.weights.A ?? 0) > 0, "动量最高的应入选");
  assert.ok((r.weights.C ?? 0) === 0, "负动量不应入选");
  assert.equal(Object.keys(r.weights).length, 2, "最多持有 maxPositions 个");
  assert.ok(Object.values(r.weights).every((w) => w <= LIMITS.maxPositionWeight + 1e-9));

  const flat = await base.allocate([snap("A", 0), snap("B", -0.01)]);
  assert.deepEqual(flat.weights, {}, "无正动量时空仓");
  assert.equal(flat.cashWeight, 1);
});

test("资产配置：AI 选出来的标的直接决定持仓", async () => {
  // 模型明确只要 BTC，并且给一个会越界的配置，验证裁剪生效
  const llm: LLMClient = {
    name: "mock",
    async complete() {
      throw new Error("不该走 complete");
    },
    async allocate() {
      return JSON.stringify({
        allocations: { BTC: 0.6, ETH: 0.1, SOL: 0.5 },
        confidence: 0.8,
        reason: "只看好 BTC",
      });
    },
  };
  const limits = { maxPositions: 2, maxPositionWeight: 0.5, grossCap: 0.9 };
  const ai = new AIAllocator(new CrossSectionalAllocator(limits), llm, limits);
  const r = await ai.allocate([snap("BTC", 0.01), snap("ETH", 0.02), snap("SOL", 0.03)]);
  assert.equal(r.source, "ai");
  assert.equal(r.reason, "只看好 BTC");
  assert.ok(r.weights.BTC! > 0 && r.weights.SOL! > 0);
  assert.equal(r.weights.ETH, undefined, "被裁掉的标的权重为 0");
  assert.ok(r.weights.BTC! <= 0.5 + 1e-9, "单标的封顶 0.5");
  assert.ok(r.notes.length > 0, "裁剪过程要有说明");
});

test("资产配置：模型不可用/输出非法时回退动量基线", async () => {
  const broken: LLMClient = {
    name: "broken",
    async complete() {
      return "not json at all";
    },
    async allocate() {
      return "我建议全仓买入";
    },
  };
  const ai = new AIAllocator(new CrossSectionalAllocator(LIMITS), broken, LIMITS);
  const r = await ai.allocate([snap("A", 0.04), snap("B", -0.01)]);
  assert.equal(r.source, "fallback");
  assert.ok((r.weights.A ?? 0) > 0, "回退后仍应按动量持有 A");
  assert.ok(r.notes[0]!.includes("模型输出不可用"));

  // 没有模型能力（allocate 未实现）-> 同样是回退而不是报错
  const noAlloc: LLMClient = {
    name: "chat-only",
    async complete() {
      return "{}";
    },
  };
  const r2 = await new AIAllocator(new CrossSectionalAllocator(LIMITS), noAlloc, LIMITS).allocate([
    snap("A", 0.04),
  ]);
  assert.equal(r2.source, "fallback");

  // 完全没有模型 -> 纯规则
  const r3 = await new AIAllocator(new CrossSectionalAllocator(LIMITS), null, LIMITS).allocate([
    snap("A", 0.04),
  ]);
  assert.equal(r3.source, "rules");
});

test("资产配置：Prompt 里必须写清约束与候选标的", () => {
  const prompt = buildAllocationPrompt([snap("BTC", 0.01), snap("ETH", -0.02)], LIMITS);
  assert.ok(prompt.includes("BTC") && prompt.includes("ETH"), "列出候选标的");
  assert.ok(prompt.includes("最多持有 2 个资产"));
  assert.ok(prompt.includes("单个资产权重不超过 0.5"));
  assert.ok(prompt.includes("所有权重之和不超过 1"), "写明总仓位上限");
  assert.ok(prompt.includes("不要虚构"), "要求只用给定数据");
});

test("资产配置：端到端——只买 AI 选的标的，落选的自动清仓", async () => {
  const pickBtc: { on: boolean } = { on: false };
  const llm: LLMClient = {
    name: "mock",
    async complete() {
      return "{}";
    },
    async allocate(_prompt, symbols) {
      const has = symbols.includes("BTC") && symbols.includes("震荡整理");
      return JSON.stringify({
        allocations: has
          ? pickBtc.on
            ? { BTC: 0.5, "震荡整理": 0 }
            : { BTC: 0, "震荡整理": 0.5 }
          : { BTC: 0.3 },
        confidence: 0.9,
        reason: pickBtc.on ? "轮到买 BTC" : "轮到买 震荡整理",
      });
    },
  };

  const config = {
    ...testConfig(),
    llm: { ...testConfig().llm, enabled: true },
    strategy: {
      ...testConfig().strategy,
      decisionSource: "chat" as const,
      selfAllocating: true,
      maxPositions: 1,
      allocationInterval: 1,
      maxGrossExposure: 0.6,
    },
    risk: { ...testConfig().risk, maxPositionWeight: 0.6, initialCash: 100_000 },
  };

  const adapter = testAdapter();
  const pipeline = buildPipeline(config, { adapter, liveTrading: false, llm });
  assert.ok(pipeline.allocator, "应装配出配置器");

  const groups = await Promise.all([
    adapter.fetchKlines("BTC", "1m", 120),
    adapter.fetchKlines("震荡整理", "1m", 120),
  ]);
  const bars = mergeBarsByTime(groups);

  const allocations: Allocation[] = [];
  const signals: Signal[] = [];
  pipeline.bus.subscribe(Topic.ALLOCATION, (e) => allocations.push(e.payload as Allocation));
  pipeline.bus.subscribe(Topic.SIGNAL, (e) => signals.push(e.payload as Signal));

  // 第一阶段：先买 震荡整理。成交口径是"决策的下一根 K 线"，
  // 所以判断持仓前多喂一根 —— 让排队的买单落地。
  // 多喂几根：成交在"决策的下一根 K 线"，且第一次决策出现在各标的凑满
  // 预热窗口之后（快照只含单一标的的那一轮，会先买下它，随后被 0 权重清掉）。
  await streamBars(pipeline.bus, pipeline.book, bars.slice(0, 84));
  const positions = () => pipeline.portfolio.positionsSnapshot();
  const weightOf = (symbol: string) => {
    const pos = positions().find((p) => p.symbol === symbol);
    if (!pos) return 0;
    const px = pipeline.book.last(symbol) ?? pos.avgCost;
    return (pos.quantity * px) / pipeline.portfolio.equity();
  };
  const held = positions().map((p) => p.symbol);
  assert.ok(held.includes("震荡整理"), `第一阶段应持有 震荡整理，实际 ${held.join(",") || "空"}`);
  // 落选的 BTC 必须被清到可忽略：风控刻意不为"不足 1 个单位"的零碎调仓下单，
  // 所以这里按权重断言而不是要求精确为 0。
  assert.ok(
    weightOf("BTC") < 0.005,
    `落选的 BTC 应被清仓，实际权重 ${(weightOf("BTC") * 100).toFixed(3)}%`,
  );
  assert.equal(allocations[0]!.source, "ai");
  assert.match(allocations[0]!.reason, /轮到买 震荡整理/);
  // 未入选的标的必须收到 0 权重信号（否则不会卖）
  assert.ok(
    signals.some((s) => s.symbol === "BTC" && s.targetWeight === 0),
    "落选标的要收到 0 权重信号以便清仓",
  );

  // 第二阶段：模型改主意，换成 BTC
  pickBtc.on = true;
  await streamBars(pipeline.bus, pipeline.book, bars.slice(84, 104));
  const held2 = positions().map((p) => p.symbol);
  assert.ok(held2.includes("BTC"), `第二轮应买入 BTC，实际持仓 ${held2.join(",") || "空"}`);
  assert.ok(
    allocations.some((a) => /轮到买 BTC/.test(a.reason)),
    "应记录到模型换仓的决策",
  );

  const m = pipeline.portfolio.metrics();
  assert.ok(m.totalFills > 0, `应产生成交，实际 ${m.totalFills}`);
});

test("配置器：每 N 轮行情都会重新决策（回归：节流计数器只自增一次会永远卡住）", async () => {
  let calls = 0;
  const llm: LLMClient = {
    name: "mock",
    async complete() {
      return "{}";
    },
    async allocate(_p, symbols) {
      calls += 1;
      return JSON.stringify({ allocations: { [symbols[0]!]: 0.4 }, confidence: 0.6, reason: "配置" });
    },
  };
  const base = testConfig();
  const config = {
    ...base,
    strategy: {
      ...base.strategy,
      decisionSource: "chat" as const,
      selfAllocating: true,
      maxPositions: 2,
      maxGrossExposure: 0.8,
      // 预热 20 根，每 5 轮决策一次
      allocationInterval: 5,
      slowWindow: 20,
    },
  };
  const adapter = testAdapter();
  const pipeline = buildPipeline(config, { adapter, liveTrading: false, llm });
  const allocations: Allocation[] = [];
  pipeline.bus.subscribe(Topic.ALLOCATION, (e) => allocations.push(e.payload as Allocation));

  const groups = await Promise.all([
    adapter.fetchKlines("BTC", "1m", 220),
    adapter.fetchKlines("震荡整理", "1m", 220),
  ]);
  await streamBars(pipeline.bus, pipeline.book, mergeBarsByTime(groups));

  // 220 根 × 2 标的、预热 20 根、每 5 轮一次 -> 至少 20 次以上
  assert.ok(
    allocations.length >= 20,
    `决策次数过少，说明节流失效：220 根 K 线只决策了 ${allocations.length} 次`,
  );
  assert.ok(calls >= 20, `模型调用次数应与决策次数一致，实际 ${calls}`);
});
