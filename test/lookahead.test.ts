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
import { PriceBook, streamBars } from "../src/data/streaming.js";
import { PaperBroker } from "../src/execution/paperBroker.js";
import type { Bar, OrderIntent } from "../src/core/types.js";

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
