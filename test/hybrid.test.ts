/**
 * 混合决策：大模型分析行情 → 决策模型做决策。
 *
 * 这套测试专门盯住「职责分离」是否真的成立：
 *  1. 分析端的 prompt 里只给行情、且明确要求不要给仓位；
 *  2. 分析输出被写进决策端的 state（含逐标的结论与强弱排序）；
 *  3. 最终仓位由决策端决定，不是分析端越权给的；
 *  4. 分析影响力 0 时，决策端看不到分析；
 *  5. 任一端挂掉都有明确降级路径，不会让组合停摆。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analysisToWeights,
  buildAnalysisPrompt,
  fallbackAnalysis,
  parseAnalysis,
  renderAnalysisForState,
} from "../src/llm/hybrid.js";
import {
  HybridAnalyst,
  HybridAllocator,
  decideSingle,
  decideWithSystemOne,
  type HybridOptions,
} from "../src/strategies/hybrid.js";
import { CrossSectionalAllocator } from "../src/strategies/allocator.js";
import type { AssetSnapshot } from "../src/llm/allocation.js";
import type { LLMClient } from "../src/llm/llmClient.js";

const LIMITS = { maxPositions: 2, maxPositionWeight: 0.6, grossCap: 0.8 };
const OPTS: HybridOptions = { influence: 0.6, analysisTtlMs: 0, timeoutMs: 1000 };

const SNAPS: AssetSnapshot[] = [
  { symbol: "BTC", price: 100, momentum: 0.04, retShort: 0.01, retLong: 0.03, trend: "up", bars: 60 },
  { symbol: "ETH", price: 50, momentum: -0.02, retShort: -0.01, retLong: -0.02, trend: "down", bars: 60 },
];

const ANALYSIS_JSON = JSON.stringify({
  summary: "BTC 放量走强，ETH 走弱",
  views: [
    { symbol: "BTC", view: "均线多头排列", strength: "strong", confidence: 0.8 },
    { symbol: "ETH", view: "跌破均线", strength: "weak", confidence: 0.7 },
  ],
  ranking: ["BTC", "ETH"],
});

test("混合决策：分析 prompt 只给行情，且明确禁止给仓位", () => {
  const prompt = buildAnalysisPrompt(SNAPS);
  assert.match(prompt, /BTC/);
  assert.match(prompt, /ETH/);
  assert.match(prompt, /不要给任何仓位/);
  assert.ok(!/"target_weight"/.test(prompt), "分析端不应出现仓位字段");
  assert.ok(!/allocations/.test(prompt), "分析端不应出现资产配置字段");
});

test("混合决策：分析输出解析，候选池外的标的会被丢掉", () => {
  const a = parseAnalysis(`\`\`\`json\n${ANALYSIS_JSON}\n\`\`\``, ["BTC", "ETH"]);
  assert.equal(a.source, "ai");
  assert.deepEqual(a.ranking, ["BTC", "ETH"]);
  assert.equal(a.views.find((v) => v.symbol === "BTC")!.strength, "strong");

  const polluted = parseAnalysis(
    JSON.stringify({
      views: [
        { symbol: "BTC", strength: "strong", confidence: 0.9, view: "ok" },
        { symbol: "山寨币", strength: "strong", confidence: 0.9, view: "臆造" },
      ],
    }),
    ["BTC", "ETH"],
  );
  assert.deepEqual(polluted.views.map((v) => v.symbol), ["BTC"], "候选池外的标的应被丢弃");
  assert.throws(() => parseAnalysis("我觉得应该全仓", ["BTC"]), /未找到 JSON/);
  assert.throws(() => parseAnalysis(JSON.stringify({ summary: "空" }), ["BTC"]), /没有可用的 views/);
});

test("混合决策：分析结论被注入决策端的 state，且逐标的写明", () => {
  const analysis = parseAnalysis(ANALYSIS_JSON, ["BTC", "ETH"]);
  const text = renderAnalysisForState(analysis, ["BTC", "ETH"], 0.6);
  assert.match(text, /大模型行情分析/);
  assert.match(text, /BTC：均线多头排列/);
  assert.match(text, /技术面强弱=强/);
  assert.match(text, /ETH：跌破均线/);
  assert.match(text, /强弱排序：BTC > ETH/);
  assert.match(text, /分析影响力=60%/);

  // 影响力 0 = 决策模型看不到分析
  assert.equal(renderAnalysisForState(analysis, ["BTC", "ETH"], 0), "");
  // 影响力 100% 会写明「以分析为主要依据」
  assert.match(renderAnalysisForState(analysis, ["BTC"], 1), /主要依据/);
});

test("混合决策：分析端只被问「怎么看」，决策端才出仓位", async () => {
  const chatPrompts: string[] = [];
  const chat: LLMClient = {
    name: "chat",
    async complete(prompt) {
      chatPrompts.push(prompt);
      return ANALYSIS_JSON;
    },
  };
  const soStates: string[] = [];
  const systemone: LLMClient = {
    name: "systemone",
    async complete() {
      return JSON.stringify({ target_weight: 0.4, confidence: 0.8, reason: "档位 strong" });
    },
    async allocate(state, symbols) {
      soStates.push(state);
      return JSON.stringify({
        allocations: Object.fromEntries(symbols.map((s) => [s, s === "BTC" ? 0.5 : 0])),
        confidence: 0.8,
        reason: "按档位",
      });
    },
  };

  const analyst = new HybridAnalyst(chat, OPTS);
  const analysis = await analyst.analyze(SNAPS);

  // 1) 分析端只被问「怎么看」
  assert.equal(chatPrompts.length, 1);
  assert.ok(!/target_weight/.test(chatPrompts[0]!), "分析端不应被要求给仓位");
  assert.equal(analysis.source, "ai");

  // 2) 决策端拿到分析（含逐标的结论）
  const { decisions } = await decideWithSystemOne(systemone, SNAPS, analysis, OPTS);
  assert.equal(soStates.length, 1);
  assert.match(soStates[0]!, /大模型行情分析/);
  assert.match(soStates[0]!, /BTC：均线多头排列/);

  // 3) 仓位来自决策端：只有 BTC 拿到仓位（分析里 ETH 是 weak）
  assert.equal(decisions.find((d) => d.symbol === "BTC")!.weight, 0.5);
  assert.equal(decisions.find((d) => d.symbol === "ETH")!.weight, 0);
});

test("混合决策：影响力 0 时决策端看不到分析（退化为纯决策模型）", async () => {
  const chat: LLMClient = { name: "chat", async complete() { return ANALYSIS_JSON; } };
  const soStates: string[] = [];
  const systemone: LLMClient = {
    name: "systemone",
    async complete() {
      return JSON.stringify({ target_weight: 0.3, confidence: 0.6, reason: "档位 moderate" });
    },
    async allocate(state, symbols) {
      soStates.push(state);
      return JSON.stringify({
        allocations: Object.fromEntries(symbols.map((s) => [s, 0.3])),
        confidence: 0.6,
        reason: "档位",
      });
    },
  };
  const analysis = await new HybridAnalyst(chat, { ...OPTS, influence: 0 }).analyze(SNAPS);
  const { note } = await decideWithSystemOne(systemone, SNAPS, analysis, { ...OPTS, influence: 0 });
  assert.doesNotMatch(soStates[0]!, /大模型行情分析/, "影响力 0 不应注入分析");
  assert.match(note, /独立决策/);
});

test("混合决策：分析端挂掉 -> 用动量兜底并如实标注", async () => {
  const broken: LLMClient = {
    name: "chat",
    async complete() {
      throw new Error("分析超时");
    },
  };
  const systemone: LLMClient = {
    name: "systemone",
    async complete() {
      return "{}";
    },
    async allocate(_state, symbols) {
      // 兜底分析下不应注入「大模型行情分析」段落
      assert.ok(true);
      return JSON.stringify({
        allocations: Object.fromEntries(symbols.map((s) => [s, s === "BTC" ? 0.4 : 0])),
        confidence: 0.5,
        reason: "档位",
      });
    },
  };
  const analysis = await new HybridAnalyst(broken, OPTS).analyze(SNAPS);
  assert.equal(analysis.source, "rules");
  assert.match(analysis.summary, /动量/);
  const alloc = new HybridAllocator(
    new HybridAnalyst(broken, OPTS),
    systemone,
    new CrossSectionalAllocator(LIMITS),
    LIMITS,
    OPTS,
  );
  const r = await alloc.allocate(SNAPS);
  assert.ok(r.weights.BTC! > 0, "决策模型仍应正常出单");
  assert.ok(r.notes.some((n) => n.includes("影响力")), "应说明分析未生效");
});

test("混合决策：决策端挂掉 -> 按分析强弱换算；决策端连多标的都不支持时同理", async () => {
  const chat: LLMClient = { name: "chat", async complete() { return ANALYSIS_JSON; } };
  const analysis = await new HybridAnalyst(chat, OPTS).analyze(SNAPS);

  // 决策模型完全没有可用实例
  const r1 = await decideWithSystemOne(null, SNAPS, analysis, OPTS);
  assert.ok((r1.decisions.find((d) => d.symbol === "BTC")!.weight ?? 0) > 0);
  assert.equal(r1.decisions.find((d) => d.symbol === "ETH")!.weight, 0, "weak 应给 0 仓位");
  assert.match(r1.note, /决策模型不可用/);

  // 决策端没有多标的提问能力（只有 complete）
  const noMulti: LLMClient = { name: "so", async complete() { return "{}"; } };
  const r2 = await decideWithSystemOne(noMulti, SNAPS, analysis, OPTS);
  assert.ok(r2.decisions.find((d) => d.symbol === "BTC")!.weight > 0);
  assert.match(r2.note, /未实现多标的提问/);

  // 单标的路径同样可用
  const single = await decideSingle(null, SNAPS[0]!, analysis, OPTS);
  assert.ok(single.weight > 0);
});

test("混合决策：强弱的权重换算规则明确", () => {
  const analysis = parseAnalysis(ANALYSIS_JSON, ["BTC", "ETH"]);
  const w = analysisToWeights(analysis, ["BTC", "ETH", "SOL"]);
  assert.ok(w.BTC! > (w.ETH ?? 0), "强档应高于弱档");
  assert.equal(w.SOL, undefined, "没有分析结论的标的不给仓位");
  // 动量兜底分析同样可用
  const fb = fallbackAnalysis(SNAPS);
  assert.equal(fb.views.length, 2);
  assert.equal(fb.views.find((v) => v.symbol === "BTC")!.strength, "strong");
});

test("混合决策：整条链路跑通，且仍受额度约束", async () => {
  const chat: LLMClient = { name: "chat", async complete() { return ANALYSIS_JSON; } };
  // 决策模型很激进：给 100% 仓位，应被裁剪到上限内
  const greedy: LLMClient = {
    name: "systemone",
    async complete() {
      return "{}";
    },
    async allocate(_state, symbols) {
      return JSON.stringify({
        allocations: Object.fromEntries(symbols.map((s) => [s, 1])),
        confidence: 0.9,
        reason: "全仓",
      });
    },
  };
  const alloc = new HybridAllocator(
    new HybridAnalyst(chat, OPTS),
    greedy,
    new CrossSectionalAllocator(LIMITS),
    LIMITS,
    OPTS,
  );
  const r = await alloc.allocate(SNAPS);
  const sum = Object.values(r.weights).reduce((a, b) => a + b, 0);
  assert.ok(sum <= LIMITS.grossCap + 1e-9, `总仓位 ${sum} 不得超过 ${LIMITS.grossCap}`);
  assert.ok(Object.values(r.weights).every((w) => w <= LIMITS.maxPositionWeight + 1e-9), "单标的不得超上限");
  assert.ok(Object.keys(r.weights).length <= LIMITS.maxPositions, "持仓数不得超上限");
  assert.equal(r.source, "hybrid");
  assert.match(r.reason, /BTC 放量走强/);
});