import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SystemOneClient,
  parseScoreAnswer,
  extractAnswer,
  extractProbabilities,
  buildStateFromPrompt,
} from "../src/llm/systemOne.js";
import { LlmManager } from "../src/llm/llmManager.js";
import { runComparison, buildRunners, type RunnerSpec } from "../src/bench/comparison.js";
import { testConfig, testAdapter } from "./helpers.js";
import type { LLMClient } from "../src/llm/llmClient.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "aaaaai-dec-"));
}

/** 拦截 fetch 的评分响应 */
function mockSystemOne(answer: Record<string, unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ answers: { position: answer } }), {
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("System One: 概率分布换算目标仓位（加权期望）", () => {
  const weights = [0, 0.25, 0.5, 0.9];
  // 概率集中在 moderate(0.5) 与 strong(0.9)
  const r = parseScoreAnswer(
    { label: "moderate", probabilities: { flat: 0, weak: 0, moderate: 0.7, strong: 0.3 }, confidence: 0.9 },
    weights,
  );
  const expected = 0.7 * 0.5 + 0.3 * 0.9;
  assert.ok(Math.abs(r.targetWeight - expected) < 1e-6, `期望仓位 ${expected}，实际 ${r.targetWeight}`);
  assert.equal(r.confidence, 0.9);
  assert.equal(r.level, "moderate");
});

test("System One: 概率为数组形式也支持", () => {
  const r = parseScoreAnswer({ probabilities: [0.25, 0.25, 0.25, 0.25] }, [0, 0.25, 0.5, 0.9]);
  assert.ok(Math.abs(r.targetWeight - 0.4125) < 1e-6, `实际 ${r.targetWeight}`);
});

test("System One: 无概率时退化用选中档位；无 confidence 时用熵近似", () => {
  const byValue = parseScoreAnswer({ value: 3 }, [0, 0.25, 0.5, 0.9]);
  assert.equal(byValue.targetWeight, 0.9, "value=3 对应第 4 档 0.9");
  assert.ok(byValue.confidence >= 0 && byValue.confidence <= 1);

  const uncertain = parseScoreAnswer({ label: "x", probabilities: [0.25, 0.25, 0.25, 0.25] }, [0, 0.25, 0.5, 0.9]);
  assert.ok(uncertain.confidence < 0.1, "均匀分布的置信度应接近 0");
  const certain = parseScoreAnswer({ probabilities: [0, 0, 0, 1] }, [0, 0.25, 0.5, 0.9]);
  assert.ok(certain.confidence > 0.95, "确定分布的置信度应接近 1");
});

test("System One: 响应外壳兼容（answers/answers.position/单键）", () => {
  assert.deepEqual(extractAnswer({ answers: { position: { value: 1 } } }), { value: 1 });
  assert.deepEqual(extractAnswer({ answers: { q1: { value: 2 } } }), { value: 2 });
  assert.deepEqual(extractAnswer({ results: { decision: { value: 3 } } }), { value: 3 });
  assert.throws(() => extractAnswer({ foo: "bar" }), /找不到答案字段/);
  assert.deepEqual(extractProbabilities({ probabilities: { a: 0.5, b: 0.5 } }), [0.5, 0.5]);
  assert.deepEqual(extractProbabilities({}), []);
});

test("System One: 客户端发出正确请求并返回策略可解析的 JSON", async () => {
  let captured: { url?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = url.toString();
    captured.body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    captured.headers = init?.headers as Record<string, string>;
    return new Response(
      JSON.stringify({ answers: { position: { label: "strong", probabilities: [0, 0, 0.2, 0.8], confidence: 0.95 } } }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const client = new SystemOneClient({
      baseUrl: "https://jev-api.com/v1",
      apiKey: "k-test",
      model: "jev-latest",
      timeoutMs: 5000,
      levels: ["flat", "weak", "moderate", "strong"],
      levelWeights: [0, 0.25, 0.5, 0.9],
      instructions: "评估上涨强度",
      buildState: buildStateFromPrompt,
    });
    const out = await client.complete("指令\n\n最近 K 线\n2024-01-01 O=1 H=2 L=0.5 C=1.5");
    assert.equal(captured.url, "https://jev-api.com/v1/systemone", "应命中 /v1/systemone");
    assert.equal(captured.headers?.Authorization, "Bearer k-test");
    assert.equal((captured.body as { model: string }).model, "jev-latest");
    const qs = (captured.body as { questions: Record<string, { type: string; levels?: string[] }> }).questions;
    assert.equal(qs.position?.type, "score");
    assert.deepEqual(qs.position?.levels, ["flat", "weak", "moderate", "strong"]);
    assert.match(String((captured.body as { state: string }).state), /C=1\.5/, "state 应包含行情文本");

    const parsed = JSON.parse(out) as { target_weight: number; confidence: number; reason: string };
    assert.ok(parsed.target_weight > 0 && parsed.target_weight <= 1);
    assert.equal(parsed.confidence, 0.95);
    assert.match(parsed.reason, /^systemone:jev-latest\/strong$/);
  } finally {
    globalThis.fetch = original;
  }
});

test("System One: 档位不足 2 个时报错", async () => {
  const client = new SystemOneClient({
    baseUrl: "https://x.test/v1",
    apiKey: "k",
    model: "m",
    timeoutMs: 100,
    levels: ["only"],
    levelWeights: [0.5],
    instructions: "i",
    buildState: (p) => p,
  });
  await assert.rejects(() => client.complete("x"), /至少需要 2 个档位/);
});

test("LlmManager: systemone 类型实例独立成池，不与对话模型混用", async () => {
  const dir = tmpDir();
  try {
    const m = new LlmManager(dir, "round-robin");
    const chat = m.create({ label: "chat", kind: "chat", baseUrl: "https://a.test/v1", model: "gpt", apiKey: "k" });
    const so = m.create({
      label: "jev",
      kind: "systemone",
      baseUrl: "https://jev-api.com/v1",
      model: "jev-latest",
      apiKey: "k",
    });
    assert.equal(m.list().length, 2);

    // 按类型过滤
    assert.equal(m.available("chat").length, 1);
    assert.equal(m.available("systemone").length, 1);
    assert.equal(m.available("chat")[0]!.id, chat.id);
    assert.equal(m.available("systemone")[0]!.id, so.id);

    // 轮询在同类型池内进行
    const picks = Array.from({ length: 4 }, () => m.pick("systemone")!.id);
    assert.ok(picks.every((id) => id === so.id));

    // 直连客户端（对照实验用）
    const pair = m.clientFor(so.id);
    assert.ok(pair && pair.profile.model === "jev-latest");
    assert.equal(m.clientFor("nope"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 测试用假模型：永远给固定权重 */
function fixedClient(weight: number): LLMClient {
  return {
    name: `fixed-${weight}`,
    async complete() {
      return JSON.stringify({ target_weight: weight, confidence: 0.8, reason: `[llm] w=${weight}` });
    },
  };
}

test("多模型对照：同一份行情、同一资金、各自独立记账", async () => {
  const config = testConfig();
  const runners: RunnerSpec[] = [
    { id: "baseline", label: "基线", kind: "baseline", client: null },
    { id: "model-a", label: "模型A", kind: "chat", model: "A", client: fixedClient(0.6) },
    { id: "model-b", label: "模型B", kind: "chat", model: "B", client: fixedClient(0.05) },
  ];
  const result = await runComparison(config, {
    adapter: testAdapter(),
    symbols: ["DEMO-BTC"],
    bars: 80,
    interval: "1m",
    liveTrading: false,
    runners,
  });

  assert.equal(result.results.length, 3);
  assert.equal(result.bars, 80);
  assert.equal(result.initialCash, config.risk.initialCash);

  // 每个选手的权益曲线长度一致（同一份行情）
  for (const r of result.results) {
    assert.equal(r.equityCurve.length, 80, `${r.label} 权益点数应一致`);
  }
  // 结果顺序 = 选手声明顺序（前端按此渲染卡片）
  assert.deepEqual(result.results.map((r) => r.id), runners.map((r) => r.id));
  // 仓位越高的选手成交更多（同一行情下更积极）
  const byId = new Map(result.results.map((r) => [r.id, r]));
  assert.ok(byId.get("model-a")!.fillCount >= byId.get("model-b")!.fillCount, "高目标仓位模型成交应不少于低仓位模型");
  // 权益都是正的（组合层面）
  for (const r of result.results) assert.ok(r.finalEquity > 0);
  // 排行按收益率降序
  const expectedWinners = [...result.results].sort((a, b) => b.totalReturn - a.totalReturn).map((r) => r.id);
  assert.deepEqual(result.winners, expectedWinners);
  // 模型选手必须真的用上了模型（否则「对照」就是在比同一份规则）
  assert.notEqual(
    byId.get("model-a")!.totalReturn,
    byId.get("baseline")!.totalReturn,
    "chat 选手应按自己的模型决策，结果不应与纯规则基线一致",
  );
});

test("多模型对照：无选手时返回空结果", async () => {
  const result = await runComparison(testConfig(), {
    adapter: testAdapter(),
    symbols: ["DEMO-BTC"],
    bars: 30,
    interval: "1m",
    liveTrading: false,
    runners: [],
  });
  assert.equal(result.results.length, 0);
  assert.deepEqual(result.winners, []);
});

test("buildRunners: 自动带上基线、跳过不可用实例", () => {
  const profiles = [
    { id: "p1", label: "可用", kind: "chat" as const, model: "m1", enabled: true, hasKey: true },
    { id: "p2", label: "无密钥", kind: "chat" as const, model: "m2", enabled: true, hasKey: false },
    { id: "p3", label: "停用", kind: "systemone" as const, model: "m3", enabled: false, hasKey: true },
    { id: "p4", label: "决策模型", kind: "systemone" as const, model: "m4", enabled: true, hasKey: true },
  ];
  const clientFor = (id: string) =>
    profiles.find((p) => p.id === id) ? { client: fixedClient(0.3), profile: { model: "x" } } : null;

  const runners = buildRunners({ profiles, clientFor, includeBaseline: true });
  assert.deepEqual(runners.map((r) => r.id), ["baseline", "p1", "p4"]);
  assert.equal(runners[0]!.kind, "baseline");
  assert.equal(runners[2]!.kind, "systemone");

  const noBaseline = buildRunners({ profiles, clientFor, includeBaseline: false });
  assert.equal(noBaseline.length, 2);
});


test("决策来源：默认 rules，旧配置 llm.enabled=true 会迁移为 chat", async () => {
  const { buildConfig } = await import("../src/configSchema.js");

  // 未配置 -> 纯规则（最安全的默认值）
  assert.equal(buildConfig({}).strategy.decisionSource, "rules");

  // 旧字段：llm.enabled=true 且无 decision_source -> 迁移为 chat
  const legacy = buildConfig({ llm: { enabled: true } });
  assert.equal(legacy.strategy.decisionSource, "chat", "旧的 llm.enabled 应迁移为 chat");

  // 显式值优先
  assert.equal(buildConfig({ strategy: { decision_source: "systemone" } }).strategy.decisionSource, "systemone");
  assert.equal(buildConfig({ strategy: { decision_source: "rules" }, llm: { enabled: true } }).strategy.decisionSource, "rules");

  // 非法值回落 rules
  assert.equal(buildConfig({ strategy: { decision_source: "瞎写" } }).strategy.decisionSource, "rules");
});

test("决策来源：配置可写回 YAML（decision_source）", async () => {
  const { buildConfig, serializeConfig } = await import("../src/configSchema.js");
  const raw = serializeConfig(buildConfig({ strategy: { decision_source: "systemone" } })) as {
    strategy: Record<string, unknown>;
  };
  assert.equal(raw.strategy.decision_source, "systemone");
});

test("模型池：poolCounts 按类型统计可用实例", () => {
  const dir = tmpDir();
  try {
    const m = new LlmManager(dir, "round-robin");
    m.create({ label: "c1", kind: "chat", baseUrl: "https://a.test/v1", model: "m", apiKey: "k" });
    m.create({ label: "c2", kind: "chat", baseUrl: "https://b.test/v1", model: "m", apiKey: "" });
    m.create({ label: "s1", kind: "systemone", baseUrl: "https://c.test/v1", model: "m", apiKey: "k" });

    const pools = m.poolCounts();
    assert.deepEqual(pools.chat, { total: 2, available: 1 }, "对话池 2 个配置、1 个可用");
    assert.deepEqual(pools.systemone, { total: 1, available: 1 });

    // 当前生效的模型池可切换
    assert.equal(m.getActiveKind(), "chat");
    m.setActiveKind("systemone");
    assert.equal(m.getActiveKind(), "systemone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("对照实验：每个选手只跑自己那一路，基线绝不调用模型", async () => {
  const config = testConfig();
  config.strategy.decisionSource = "rules"; // 全局是纯规则，但对照实验要单变量
  let chatCalls = 0;
  let soCalls = 0;
  const chatSpy: LLMClient = {
    name: "chat",
    async complete() {
      chatCalls += 1;
      return JSON.stringify({ target_weight: 0.5, confidence: 1, reason: "[llm]" });
    },
  };
  const soSpy: LLMClient = {
    name: "so",
    async complete() {
      soCalls += 1;
      return JSON.stringify({ target_weight: 0.5, confidence: 1, reason: "[llm]" });
    },
  };
  const result = await runComparison(config, {
    adapter: testAdapter(),
    symbols: ["DEMO-BTC"],
    bars: 40,
    interval: "1m",
    liveTrading: false,
    runners: [
      { id: "b", label: "基线", kind: "baseline", client: null },
      { id: "c", label: "对话", kind: "chat", client: chatSpy },
      { id: "s", label: "决策", kind: "systemone", client: soSpy },
    ],
  });
  assert.equal(result.results.length, 3);
  assert.ok(chatCalls > 0, "chat 选手应调用对话模型");
  assert.ok(soCalls > 0, "systemone 选手应调用决策模型");
  // 基线选手的收益 = 纯动量；与模型选手结果不同，说明各自只跑自己那一路
  const [baseline, chat] = result.results;
  assert.notEqual(baseline!.totalReturn, chat!.totalReturn);
});

test("对照引擎：各选手独立记账且价格簿正确（回归）", async () => {
  // 曾经踩过的坑：给每个选手另建 PriceBook，而风控 Agent 持有的是流水线内部那本，
  // 导致价格对不上、全部信号被以「无行情」拒掉，对照结果恒为 0 成交。
  const result = await runComparison(testConfig(), {
    adapter: testAdapter(),
    symbols: ["600519"],
    bars: 200,
    interval: "1m",
    liveTrading: false,
    runners: [{ id: "b", label: "基线", kind: "baseline", client: null }],
  });
  assert.ok(
    result.results[0]!.fillCount > 0,
    `基线在 600519 上应产生成交，实际 ${result.results[0]!.fillCount}`,
  );
  assert.equal(result.results[0]!.equityCurve.length, 200);
});
