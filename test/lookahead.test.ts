/**
 * 模拟可信度：模拟成交不得使用"当时还不可能知道"的价格。
 *
 * 这是所有模拟结果的信任基础。如果回测能按信号那根 K 线的收盘价成交，
 * 就会凭空多出一段现实里拿不到的利润——收益曲线好看，却不可复现。
 * 这里把不变量写成测试：成交价只能来自**下一根** K 线。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus, Topic } from "../src/core/eventBus.js";
import { PriceBook, mergeBarsByTime, streamBars } from "../src/data/streaming.js";
import { PaperBroker } from "../src/execution/paperBroker.js";
import { buildPipeline } from "../src/agents/orchestrator.js";
import type { Strategy } from "../src/strategies/strategy.js";
import type { Allocation, Bar, OrderIntent } from "../src/core/types.js";
import { testAdapter, testConfig } from "./helpers.js";

function bar(symbol: string, t: number, o: number, c: number): Bar {
  return {
    symbol,
    timestamp: new Date(t),
    open: o,
    high: Math.max(o, c),
    low: Math.min(o, c),
    close: c,
    volume: 1000,
  };
}

function setup(overrides: Partial<ConstructorParameters<typeof PaperBroker>[2]> = {}) {
  const bus = new EventBus();
  const book = new PriceBook();
  const broker = new PaperBroker(bus, book, {
    feeRate: 0.001,
    slippageBps: 0, // 关掉滑点，让成交价就是开盘价，断言才精确
    ...overrides,
  });
  const fills: { price: number; qty: number; ts: number }[] = [];
  bus.subscribe<{ order: OrderIntent; price: number; timestamp: Date }>(Topic.FILL, (e) => {
    fills.push({ price: e.payload.price, qty: e.payload.order.quantity, ts: e.payload.timestamp.getTime() });
  });
  return { bus, book, broker, fills };
}

test("流水线：同一根 BAR 里生成的订单，必须等下一根开盘成交", async () => {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const bars: Bar[] = Array.from({ length: 60 }, (_, i) => ({
    symbol: "SYM1",
    timestamp: new Date(t0 + i * 60_000),
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 1000,
  }));
  const alwaysLong: Strategy = {
    name: "always-long",
    warmup: 1,
    async generate(ctx) {
      return {
        symbol: "SYM1",
        timestamp: ctx.bars[ctx.bars.length - 1]!.timestamp,
        targetWeight: 0.5,
        confidence: 1,
        reason: "test",
      };
    },
  };
  const base = testConfig();
  const pipeline = buildPipeline(
    { ...base, risk: { ...base.risk, feeRate: 0, slippageBps: 0 } },
    { adapter: testAdapter(), liveTrading: false, strategyOverride: alwaysLong },
  );
  const fills: { price: number; ts: number }[] = [];
  const signals: number[] = [];
  pipeline.bus.subscribe(Topic.SIGNAL, (e) => {
    signals.push((e.payload as { timestamp: Date }).timestamp.getTime());
  });
  pipeline.bus.subscribe(Topic.FILL, (e) => {
    const f = e.payload as { price: number; timestamp: Date };
    fills.push({ price: f.price, ts: f.timestamp.getTime() });
  });
  await streamBars(pipeline.bus, pipeline.book, bars);
  assert.ok(fills.length >= 1, "应产生成交");
  assert.ok(signals.length >= 1, "应产生信号");
  const signalIdx = bars.findIndex((b) => b.timestamp.getTime() === signals[0]);
  assert.ok(signalIdx >= 0 && signalIdx + 1 < bars.length, "信号必须落在回放 K 线内");
  assert.equal(fills[0]!.price, bars[signalIdx + 1]!.open, "成交价必须是信号下一根的开盘价");
  assert.equal(fills[0]!.ts, bars[signalIdx + 1]!.timestamp.getTime(), "成交时间必须是信号下一根");
  assert.ok(
    fills.every((f) => f.ts > signals[0]!),
    "不能在同一根 BAR 内按本根开盘价成交",
  );
});

test("成交价必须来自下一根 K 线：不能按信号那根的收盘价成交", async () => {
  const { bus, book, broker, fills } = setup();
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);

  // 第 1 根：开盘 100，收盘 110（大涨）。决策发生在这根收盘时
  await streamBars(bus, book, [bar("SYM1", t0, 100, 110)]);
  const intent: OrderIntent = {
    symbol: "SYM1",
    side: "BUY",
    quantity: 10,
    price: 110,
    timestamp: new Date(t0),
    reason: "signal",
  };
  await broker.handle(intent);
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(fills.length, 0, "决策当根不得成交：看到收盘价时已经买不到那个价了");

  // 第 2 根：开盘 120，收盘 121 —— 订单应按这根的**开盘价 120** 成交
  await streamBars(bus, book, [bar("SYM1", t0 + 60_000, 120, 121)]);
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(fills.length, 1, "下一根 K 线到达时应成交");
  assert.equal(fills[0]!.price, 120, "成交价必须是下一根的开盘价，而不是上一根的收盘价");
  assert.notEqual(fills[0]!.price, 110, "绝不能按信号那根的收盘价成交");
});

test("跳空低开/高开都按真实开盘价成交（不按任何一根的收盘价折算）", async () => {
  for (const [nextOpen, note] of [
    [90, "低开"],
    [200, "高开"],
  ] as const) {
    const { bus, book, broker, fills } = setup();
    const t0 = Date.UTC(2026, 0, 1);
    await streamBars(bus, book, [bar("SYM1", t0, 100, 110)]);
    await broker.handle({
      symbol: "SYM1",
      side: "BUY",
      quantity: 1,
      price: 110,
      timestamp: new Date(t0),
      reason: "s",
    });
    await streamBars(bus, book, [bar("SYM1", t0 + 60_000, nextOpen, nextOpen + 1)]);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(fills.length, 1, `${note}：仍应成交`);
    assert.equal(fills[0]!.price, nextOpen, `${note}：按下一根开盘价成交`);
  }
});

test("数据结束时未轮到成交的订单作废，不按最后一根收盘价凑成交", async () => {
  const { bus, book, broker, fills } = setup();
  const t0 = Date.UTC(2026, 0, 1);
  await streamBars(bus, book, [bar("SYM1", t0, 100, 110)]);
  await broker.handle({
    symbol: "SYM1",
    side: "BUY",
    quantity: 1,
    price: 110,
    timestamp: new Date(t0),
    reason: "s",
  });
  // 此后再无 K 线（回测数据结束）
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fills.length, 0, "没有下一根 K 线就没有成交：不能拿当前价凑一笔");
});

test("开盘价缺失/异常时不成交（宁可漏单，不用离谱价格造利润）", async () => {
  const { bus, book, broker, fills } = setup();
  const t0 = Date.UTC(2026, 0, 1);
  await streamBars(bus, book, [bar("SYM1", t0, 100, 110)]);
  await broker.handle({
    symbol: "SYM1",
    side: "BUY",
    quantity: 1,
    price: 110,
    timestamp: new Date(t0),
    reason: "s",
  });
  // 下一根开盘价为 0（脏数据）
  const bad = bar("SYM1", t0 + 60_000, 0, 110);
  bad.open = 0;
  await bus.publishAsync(Topic.BAR, bad);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fills.length, 0, "开盘价不可用时不应成交");
});

test("多标的时间线各自独立：A 的订单不会被 B 的 K 线成交掉", async () => {
  const { bus, book, broker, fills } = setup();
  const t0 = Date.UTC(2026, 0, 1);
  await streamBars(bus, book, [bar("SYM1", t0, 100, 110)]);
  await broker.handle({
    symbol: "SYM1",
    side: "BUY",
    quantity: 1,
    price: 110,
    timestamp: new Date(t0),
    reason: "s",
  });
  // B 的 K 线先到：A 的订单不能因此成交（价格是 A 的）
  await streamBars(bus, book, [bar("SYM2", t0 + 1000, 5, 6)]);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fills.length, 0, "别的标的的 K 线不能成交本标的的订单");

  await streamBars(bus, book, [bar("SYM1", t0 + 60_000, 130, 131)]);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fills.length, 1);
  assert.equal(fills[0]!.price, 130);
});

test("拆单：首片也等下一根 K 线，且按开盘价成交", async () => {
  const { bus, book, broker, fills } = setup({
    slicing: { algo: "twap", slices: 3, sliceSpacingBars: 1 },
  });
  const t0 = Date.UTC(2026, 0, 1);
  await streamBars(bus, book, [bar("SYM1", t0, 100, 110)]);
  await broker.handle({
    symbol: "SYM1",
    side: "BUY",
    quantity: 3,
    price: 110,
    timestamp: new Date(t0),
    reason: "s",
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fills.length, 0, "拆单也不能在决策当根成交");

  await streamBars(bus, book, [bar("SYM1", t0 + 60_000, 120, 121)]);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(fills.length >= 1, "下一根应至少成交一片");
  assert.equal(fills[0]!.price, 120, "按下一根开盘价成交");
});
test("同标的未成交订单被新决策取代：否则叠单会打出反向仓位（凭空做空）", async () => {
  // 风控按组合当前持仓算调仓量，看不见已发出未成交的订单。
  // 成交延迟一根 K 线时，若每轮决策都叠一单，这些单各自按同一时的持仓定量，
  // 叠加后会把仓位打成反向 —— 那是模拟口径造出来的仓位，不是策略的决定。
  const { bus, book, broker, fills } = setup({ slippageBps: 0 });
  const t0 = Date.UTC(2026, 0, 1);
  const mk = (side: "BUY" | "SELL", quantity: number): OrderIntent => ({
    symbol: "SYM1",
    side,
    quantity,
    price: 110,
    timestamp: new Date(t0),
    reason: "signal",
  });

  await streamBars(bus, book, [bar("SYM1", t0, 100, 110)]);
  await broker.handle(mk("SELL", 5));
  await broker.handle(mk("SELL", 5));
  await streamBars(bus, book, [bar("SYM1", t0 + 60_000, 120, 121)]);

  assert.equal(fills.length, 1, "只应保留最新的那一单");
  assert.equal(fills[0]!.qty, 5, "成交数量应等于最新决策的数量");
});

/** 递归收集 web/src 下的界面文案文件。 */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist"].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSources(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("文案与成交口径一致：界面不得说成交按收盘价撮合", () => {
  // 行为由上面几条锁住；这条锁文案。用户是照着文案去核对每一笔成交的，
  // 文案把口径说反（说成按收盘价成交），他就会把正确的行为当成 bug。
  // 只扫界面目录：代码注释里讨论"为什么不能用收盘价"是正当的反例。
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "src");
  // 只认"正面断言"的说法，不用"成交…按收盘价"这种宽松模式 ——
  // 「不按收盘价凑」是正确表述，宽松模式会把它也当成违规。
  const falseClaims = [/按收盘价成交/, /按收盘价撮合/, /收盘价一次性撮合/];
  const offenders: string[] = [];
  for (const file of collectSources(root)) {
    const text = readFileSync(file, "utf8");
    for (const re of falseClaims) {
      const hit = text.match(re);
      if (hit) offenders.push(`${file.replace(root + "/", "")}: ${hit[0]}`);
    }
  }
  assert.deepEqual(offenders, [], "界面文案把成交口径说成了按收盘价，与 paperBroker「下一根开盘价成交」矛盾");

  // 光"没有坏话"不算数：界面上必须正面说清口径，否则用户无从知道成交怎么来的
  const backtest = readFileSync(join(root, "pages", "BacktestPage.tsx"), "utf8");
  assert.match(backtest, /下一根 K 线的开盘价/, "回测页应正面写清「成交按下一根 K 线开盘价」");
});

test("不同标的的未成交订单互不取代", async () => {
  const { bus, book, broker, fills } = setup({ slippageBps: 0 });
  const t0 = Date.UTC(2026, 0, 1);
  const mk = (symbol: string): OrderIntent => ({
    symbol,
    side: "BUY",
    quantity: 1,
    price: 110,
    timestamp: new Date(t0),
    reason: "s",
  });
  // 两个标的都要先有行情，否则 SYM2 的订单会被正确地驳回（无价可依）
  await streamBars(bus, book, [bar("SYM1", t0, 100, 110)]);
  await streamBars(bus, book, [bar("SYM2", t0, 200, 210)]);
  await broker.handle(mk("SYM1"));
  await broker.handle(mk("SYM2"));
  await streamBars(bus, book, [bar("SYM1", t0 + 60_000, 120, 121)]);
  await streamBars(bus, book, [bar("SYM2", t0 + 60_000, 220, 221)]);
  assert.equal(fills.length, 2, "两个标的各自成交，互不影响");
});

test("自配置流水线（xsmom 路径）：allocation 时间戳必须是本轮刚收盘那根，成交只能更晚", async () => {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  // 两个标的、60 根 1m K 线。因子窗口（trend 20 / volume 20 / breakout 60）
  // 要求足够长；两条相反走势制造横截面区分度，配置器才会选出 SYM1。
  const mkBars = (symbol: string, base: number, drift: number): Bar[] =>
    Array.from({ length: 60 }, (_, i) => ({
      symbol,
      timestamp: new Date(t0 + i * 60_000),
      open: base + drift * i,
      high: base + drift * i + 1,
      low: base + drift * i - 1,
      close: base + drift * i + drift * 0.5,
      volume: 1000,
    }));
  const base = testConfig();
  const config = {
    ...base,
    market: { ...base.market, symbols: ["SYM1", "SYM2"] },
    strategy: {
      ...base.strategy,
      selfAllocating: true,
      allocationInterval: 5, // 每 5 轮决策一次，给已入队的订单留出成交窗口
      slowWindow: 5,
      fastWindow: 2,
      maxGrossExposure: 0.6,
    },
    risk: { ...base.risk, feeRate: 0, slippageBps: 0 },
  };
  const pipeline = buildPipeline(config, { adapter: testAdapter(), liveTrading: false });
  assert.ok(pipeline.allocator, "应装配出配置器");

  const allocations: { allocTs: number; currentBarTs: number }[] = [];
  const fills: { ts: number; price: number; symbol: string; orderTs: number }[] = [];
  pipeline.bus.subscribe(Topic.ALLOCATION, (e) => allocations.push({ allocTs: (e.payload as Allocation).timestamp.getTime(), currentBarTs: currentTs }));
  pipeline.bus.subscribe(Topic.FILL, (e) => {
    const f = e.payload as { timestamp: Date; price: number; order: OrderIntent };
    fills.push({ ts: f.timestamp.getTime(), price: f.price, symbol: f.order.symbol, orderTs: f.order.timestamp.getTime() });
  });

  const allBars = mergeBarsByTime([mkBars("SYM1", 100, 1), mkBars("SYM2", 200, -0.5)]);
  // 逐根喂入；currentTs 记录「正在喂入哪根」。allocation 在处理第 t 根时发布，
  // 它的时间戳就必须是 t —— 旧实现打成前一根（t-1），撮合层据此把成交回填到
  // t 根自己的开盘价，而那个价格在决策之前就发生了（未来函数）。
  let currentTs = 0;
  for (const g of allBars) {
    currentTs = g.timestamp.getTime();
    await streamBars(pipeline.bus, pipeline.book, [g]);
  }

  assert.ok(allocations.length >= 2, `应产生多次配置决策，实际 ${allocations.length}`);
  const liars = allocations.filter((a) => a.allocTs !== a.currentBarTs);
  assert.deepEqual(
    liars,
    [],
    `allocation 时间戳必须等于决策当根 K 线；谎报前一根的有 ${liars.length} 次`,
  );

  assert.ok(fills.length >= 1, "应产生成交");
  // 因果不变量，逐笔核对：
  // 1) 每笔成交的时刻必须晚于它的订单时间戳（订单时间 = 决策那根 K 线）；
  // 2) 成交价 = 成交那根 K 线上该标的的开盘价（无滑点配置下）。
  for (const f of fills) {
    assert.ok(
      f.ts > f.orderTs,
      `成交 ${f.ts} 必须晚于订单 ${f.orderTs}（否则是用未来信息回填开盘价）`,
    );
    const fillBar = allBars.find(
      (b) => b.symbol === f.symbol && b.timestamp.getTime() === f.ts,
    );
    assert.ok(fillBar, `成交时刻 ${f.ts} 必须落在回放的 K 线上`);
    assert.equal(f.price, fillBar.open, `成交价必须是该根开盘价 ${fillBar.open}，实际 ${f.price}`);
  }
});
