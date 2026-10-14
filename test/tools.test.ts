/**
 * 大模型的工具能力：自己查新闻、看走势、看当前配置，再决策。
 *
 * 关键断言：
 * 1. 模型可以按需调用工具，查完才给答案；
 * 2. 只读——工具箱里不存在任何下单/改参数的工具；
 * 3. 有预算——轮数到顶就收尾，不会无限转圈；
 * 4. 两种协议都能走（原生 function calling 与文本协议）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultToolBox, type ToolContext } from "../src/llm/tools.js";
import { runToolAgent } from "../src/llm/agentLoop.js";
import { buildAnalysisPrompt } from "../src/llm/hybrid.js";
import type { LLMClient } from "../src/llm/llmClient.js";
import type { NewsItem } from "../src/news/types.js";

function ctx(): ToolContext {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
  return {
    candidates: () => ["600519", "BTCUSDT"],
    price: (s) => (s === "600519" ? 178 : undefined),
    history: (s, limit) =>
      s === "600519"
        ? closes.slice(-limit).map((close, i) => ({ timestamp: `2026-10-14T${String(i % 24).padStart(2, "0")}:00:00Z`, close }))
        : [],
    allocation: () => ({ equity: 100000, cash: 40000, cashWeight: 0.4, holdings: [{ symbol: "600519", weight: 0.6, marketValue: 60000, unrealizedPnl: 1200 }] }),
    performance: () => ({ totalReturn: 0.012, maxDrawdownPct: 0.03, totalFills: 12, openPositions: 1 }),
    news: async (symbol, limit) => {
      const items: NewsItem[] = [
        { id: "n1", symbol, title: `${symbol} 大幅上涨 创历史新高`, summary: "", url: "", source: "s", publishedAt: "2026-10-14T10:00:00Z", sentiment: 0.8, sentimentLabel: "positive", fetchedAt: "" },
      ];
      return items.slice(0, limit);
    },
  };
}

test("工具箱：只读，没有任何下单或改参数的入口", () => {
  const box = defaultToolBox();
  const names = box.list().map((s) => s.name);
  assert.ok(names.length >= 6, "应覆盖新闻/走势/报价/配置/表现/候选池");
  for (const forbidden of ["place_order", "buy", "sell", "order", "set_config", "update_position"]) {
    assert.ok(!names.includes(forbidden), `工具箱不应包含 ${forbidden}`);
  }
  // 未知工具要明确报错，不能静默成功
  return box.invoke("place_order", {}, ctx()).then((r) => {
    assert.equal(r.ok, false);
    assert.match(r.error!, /没有名为 place_order 的工具/);
  });
});

test("工具箱：各工具返回真实数据（历史走势会算涨跌与回撤）", async () => {
  const box = defaultToolBox();
  const c = ctx();
  const hist = await box.invoke("get_history", { symbol: "600519", limit: 60 }, c);
  assert.equal(hist.ok, true);
  const h = hist.data as { count: number; changePct: number; maxDrawdownPct: number };
  assert.equal(h.count, 60);
  assert.ok(h.changePct > 0, "上涨序列 changePct 应为正");

  const news = await box.invoke("search_news", { symbol: "600519", limit: 5 }, c);
  assert.equal(news.ok, true);
  assert.equal(((news.data as { news: unknown[] }).news).length, 1);

  const alloc = await box.invoke("get_allocation", {}, c);
  assert.equal((alloc.data as { cashWeight: number }).cashWeight, 0.4);

  // 参数缺失/越界要被夹住而不是崩
  const bad = await box.invoke("get_history", {}, c);
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /缺少 symbol/);
  const clamped = await box.invoke("search_news", { symbol: "600519", limit: 999 }, c);
  assert.equal(clamped.ok, true);
});

test("工具循环：模型先查工具，拿到结果后才给最终答案", async () => {
  const prompts: string[] = [];
  let turn = 0;
  const client: LLMClient = {
    name: "tool-user",
    async complete(prompt) {
      prompts.push(prompt);
      turn += 1;
      // 文本协议：第一轮要工具，第二轮给答案
      return turn === 1 ? '{"tool":"search_news","args":{"symbol":"600519","limit":5}}' : '{"summary":"涨势明确","views":[],"ranking":[]}';
    },
  };
  const run = await runToolAgent({
    client,
    tools: defaultToolBox(),
    context: ctx(),
    instruction: "你是研究员",
    task: buildAnalysisPrompt([
      { symbol: "600519", price: 178, momentum: 0.02, retShort: 0.01, retLong: 0.03, trend: "up", bars: 80 },
    ]),
    outputHint: "输出 JSON",
    maxSteps: 4,
    timeoutMs: 1000,
  });

  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0]!.tool, "search_news");
  assert.equal(run.steps[0]!.ok, true);
  assert.match(run.steps[0]!.brief, /1 条/);
  assert.match(run.text, /涨势明确/);
  assert.match(run.audit, /search_news->1 条/);
  // 第二轮提示里必须带上工具结果，模型才可能"基于事实"作答
  assert.ok(prompts[prompts.length - 1]!.includes("[工具结果"), "应把工具结果回传给模型");
});

test("工具循环：原生 function calling 协议同样工作", async () => {
  let turn = 0;
  const client: LLMClient = {
    name: "native",
    async complete() {
      return '{"summary":"最终结论","views":[],"ranking":[]}';
    },
    async chat(messages, tools) {
      turn += 1;
      assert.ok((tools ?? []).length > 0, "应把工具定义传给模型");
      if (turn === 1) {
        const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
        assert.match(user, /分析 600519/, "首轮应带任务");
        assert.match(user, /输出 JSON/, "首轮应带输出要求");
        return { content: "", toolCalls: [{ name: "get_allocation", args: {} }] };
      }
      // 模型应看到工具结果
      assert.ok(messages.some((m) => m.role === "tool"), "应收到工具结果");
      return { content: '{"summary":"最终结论","views":[],"ranking":[]}', toolCalls: [] };
    },
  };
  const run = await runToolAgent({
    client,
    tools: defaultToolBox(),
    context: ctx(),
    instruction: "你是研究员",
    task: "分析 600519",
    outputHint: "输出 JSON",
    maxSteps: 4,
    timeoutMs: 1000,
  });
  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0]!.tool, "get_allocation");
  assert.match(run.steps[0]!.brief, /现金/);
  assert.match(run.text, /最终结论/);
});

test("工具循环：轮数用完会收尾，不会无限转圈", async () => {
  let toolRequests = 0;
  const client: LLMClient = {
    name: "greedy",
    async complete(prompt) {
      if (prompt.includes("工具调用次数已用完")) return "收尾答案";
      toolRequests += 1;
      return '{"tool":"get_quote","args":{"symbol":"600519"}}';
    },
  };
  const run = await runToolAgent({
    client,
    tools: defaultToolBox(),
    context: ctx(),
    instruction: "你是研究员",
    task: "分析",
    outputHint: "回答",
    maxSteps: 2,
    timeoutMs: 1000,
  });
  assert.equal(run.steps.length, 2, "最多 2 轮工具调用");
  assert.equal(toolRequests, 2, "不该无限追问工具");
  assert.equal(run.text, "收尾答案", "预算用尽后应基于现有信息给答案");
});

test("工具循环：maxSteps=0 或没有工具时，退回一次性 prompt", async () => {
  let prompt = "";
  const client: LLMClient = {
    name: "plain",
    async complete(p) {
      prompt = p;
      return "答案";
    },
  };
  const run = await runToolAgent({
    client,
    tools: defaultToolBox(),
    context: ctx(),
    instruction: "你是研究员",
    task: "任务正文",
    outputHint: "输出 JSON",
    maxSteps: 0,
  });
  assert.deepEqual(run.steps, []);
  assert.equal(run.text, "答案");
  assert.match(prompt, /任务正文/);
  assert.doesNotMatch(prompt, /只读工具/, "不给工具时不该在 prompt 里列工具");
});

test("工具循环：工具报错会回传给模型，不会中断", async () => {
  let turn = 0;
  const client: LLMClient = {
    name: "err",
    async complete() {
      turn += 1;
      return turn === 1 ? '{"tool":"get_history","args":{"symbol":"不存在"}}' : "已知悉";
    },
  };
  const run = await runToolAgent({
    client,
    tools: defaultToolBox(),
    context: ctx(),
    instruction: "i",
    task: "t",
    outputHint: "o",
    maxSteps: 3,
    timeoutMs: 1000,
  });
  assert.equal(run.steps[0]!.ok, false);
  assert.match(run.steps[0]!.error!, /没有/);
  assert.equal(run.text, "已知悉");
});