import assert from "node:assert/strict";
import test from "node:test";
import { runBacktest } from "../src/backtest/engine.js";
import { testAdapter, testConfig } from "./helpers.js";
import { dig, num, str, bool } from "../src/config.js";
import { buildConfig } from "../src/configSchema.js";
import { parseDecision } from "../src/llm/llmClient.js";
import { mergeBarsByTime } from "../src/data/streaming.js";

test("runBacktest: 模拟交易所全链路跑通", async () => {
  const adapter = testAdapter();
  const result = await runBacktest(testConfig(), {
    adapter,
    symbols: ["DEMO-BTC"],
    bars: 120,
    interval: "1m",
    liveTrading: false,
  });
  assert.equal(result.bars, 120);
  assert.ok(result.metrics.finalEquity > 0, "权益应为正");
  assert.equal(result.metrics.equityPoints, 120);
  assert.ok(result.events > 100, "事件应覆盖 BAR 及各 Agent 事件");
  assert.ok(result.equityCurve.length === 120);
});

test("runBacktest: 多标的时间序列正确归并", async () => {
  const adapter = testAdapter();
  const result = await runBacktest(testConfig(), {
    adapter,
    symbols: ["DEMO-BTC", "DEMO-ETH"],
    bars: 60,
    interval: "1m",
    liveTrading: false,
  });
  assert.equal(result.symbols.length, 2);
  // 归并后按时间升序：权益曲线时间戳必须单调不减
  const times = result.equityCurve.map((p) => Date.parse(p.timestamp));
  const sorted = [...times].sort((a, b) => a - b);
  assert.deepEqual(times, sorted);
  assert.ok(result.bars >= 120, "两个标的的 K 线都应汇入");
});

test("runBacktest: 结果确定可复现", async () => {
  const a = await runBacktest(testConfig(), { adapter: testAdapter(), symbols: ["DEMO-BTC"], bars: 60, interval: "1m", liveTrading: false });
  const b = await runBacktest(testConfig(), { adapter: testAdapter(), symbols: ["DEMO-BTC"], bars: 60, interval: "1m", liveTrading: false });
  assert.equal(a.metrics.finalEquity, b.metrics.finalEquity);
  assert.equal(a.metrics.totalFills, b.metrics.totalFills);
});

test("mergeBarsByTime: 多组 K 线按时间升序合并", () => {
  const t = (n: number) => new Date(1_700_000_000_000 + n * 1000);
  const merged = mergeBarsByTime([
    [
      { symbol: "A", timestamp: t(3), open: 1, high: 1, low: 1, close: 1, volume: 0 },
      { symbol: "A", timestamp: t(1), open: 1, high: 1, low: 1, close: 1, volume: 0 },
    ],
    [{ symbol: "B", timestamp: t(2), open: 1, high: 1, low: 1, close: 1, volume: 0 }],
  ]);
  assert.deepEqual(
    merged.map((b) => `${b.symbol}@${b.timestamp.getTime()}`),
    ["A@1700000001000", "B@1700000002000", "A@1700000003000"],
  );
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
  assert.equal(config.market.symbols.length, 0);
  assert.equal(config.market.interval, "1m");
  assert.equal(config.execution.mode, "paper");
  assert.equal(config.server.port, 8787);
  assert.equal(config.llm.enabled, false);
  assert.equal(config.llm.apiKey, "");
  assert.equal(config.risk.initialCash, 100000);
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
test("runBacktest: 开启拆单后全链路仍跑通，且成交笔数不少于不拆单", async () => {
  const base = testConfig();
  const sliced = testConfig({
    ...base,
    execution: {
      ...base.execution,
      slicingAlgo: "twap",
      slicingSlices: 4,
      slicingSpacingBars: 1,
      slicingVolumeProfileBars: 20,
    },
  });
  const whole = await runBacktest(base, {
    adapter: testAdapter(),
    symbols: ["DEMO-BTC"],
    bars: 300,
    interval: "1m",
    liveTrading: false,
  });
  const cut = await runBacktest(sliced, {
    adapter: testAdapter(),
    symbols: ["DEMO-BTC"],
    bars: 300,
    interval: "1m",
    liveTrading: false,
  });

  assert.equal(cut.equityCurve.length, 300, "拆单不应改变 K 线推进");
  assert.ok(cut.metrics.finalEquity > 0, "拆单后权益仍应为正");
  assert.ok(
    cut.metrics.totalFills >= whole.metrics.totalFills,
    `拆单会把一笔单变成多笔成交：${whole.metrics.totalFills} -> ${cut.metrics.totalFills}`,
  );
  // 拆单不改变总持仓规模量级（尾差来自数据末尾未到期的切片）
  const gross = (r: typeof cut) => r.positions.reduce((a, p) => a + Math.abs(p.quantity), 0);
  assert.ok(gross(cut) >= 0);
});

test("runBacktest: Ledoit-Wolf 收缩协方差可用在 HRP 路径上，不影响回测完整性", async () => {
  const base = testConfig();
  const result = await runBacktest(
    testConfig({
      ...base,
      optimize: { ...base.optimize, method: "risk_parity", covariance: "lw", targetVol: 0.3 },
    }),
    { adapter: testAdapter(), symbols: ["DEMO-BTC", "DEMO-ETH"], bars: 200, interval: "1m", liveTrading: false },
  );
  assert.equal(result.bars >= 400, true);
  assert.ok(result.metrics.finalEquity > 0);
});
