import assert from "node:assert/strict";
import test from "node:test";
import { runBacktest } from "../src/backtest/engine.js";
import { testConfig } from "./helpers.js";
import { dig, num, str, bool } from "../src/config.js";
import { buildConfig } from "../src/configSchema.js";
import { parseDecision } from "../src/llm/llmClient.js";

test("runBacktest: stub 数据全链路跑通", async () => {
  const result = await runBacktest(testConfig(), { symbol: "TEST", bars: 120 });
  assert.equal(result.bars, 120);
  assert.ok(result.metrics.finalEquity > 0, "权益应为正");
  assert.equal(result.metrics.equityPoints, 120);
  assert.ok(result.events > 100, "事件应覆盖 BAR 及各 Agent 事件");
  assert.ok(Array.isArray(result.equityCurve));
  assert.ok(result.positions.every((p) => Number.isFinite(p.quantity)));
});

test("runBacktest: 结果确定可复现", async () => {
  const a = await runBacktest(testConfig(), { symbol: "TEST", bars: 60 });
  const b = await runBacktest(testConfig(), { symbol: "TEST", bars: 60 });
  assert.equal(a.metrics.finalEquity, b.metrics.finalEquity);
  assert.equal(a.metrics.totalFills, b.metrics.totalFills);
});

test("config: dig / num / str / bool 安全取值", () => {
  const cfg = { a: { b: 1, c: "x", d: true } };
  assert.equal(dig(cfg, "a", "b", 0), 1);
  assert.equal(dig(cfg, "a", "zzz", 42), 42);
  assert.equal(dig(cfg, "nope", "x", 7), 7);
  assert.equal(num(cfg, ["a", "b"], 0), 1);
  assert.equal(num(cfg, ["a", "c"], 0), 0); // "x" 非数值 -> 默认
  assert.equal(num({ a: { b: "3.5" } }, ["a", "b"], 0), 3.5);
  assert.equal(str(cfg, ["a", "c"], "?"), "x");
  assert.equal(str(cfg, ["a", "missing"], "fallback"), "fallback");
  assert.equal(bool(cfg, ["a", "d"], false), true);
  assert.equal(bool(cfg, ["a", "missing"], true), true);
});

test("config: buildConfig 默认值与脱敏", () => {
  const config = buildConfig({});
  assert.equal(config.market.source, "stub");
  assert.equal(config.market.symbols[0], "BTCUSDT");
  assert.equal(config.execution.dryRun, true);
  assert.equal(config.server.port, 8787);
  assert.equal(config.llm.enabled, false);
  assert.equal(config.llm.apiKey, "");
});

test("llm: parseDecision 容忍围栏与越界", () => {
  const ok = parseDecision('```json\n{"target_weight": 0.35, "confidence": 0.8, "reason": "趋势向上"}\n```');
  assert.equal(ok.targetWeight, 0.35);
  assert.equal(ok.confidence, 0.8);

  const camel = parseDecision('{"targetWeight": 1, "confidence": 2}');
  assert.equal(camel.targetWeight, 1);
  assert.equal(camel.confidence, 1); // 收敛到 1

  assert.throws(() => parseDecision("没有 JSON"));
  assert.throws(() => parseDecision('{"target_weight": 1.5}'));
  assert.throws(() => parseDecision('{"target_weight": -0.1}'));
});
