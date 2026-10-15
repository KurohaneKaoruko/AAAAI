/**
 * 拆单执行（TWAP / VWAP）：用可核对的性质自证，而不是看它跑出什么曲线。
 *
 * 核心判定：
 * - 切片计划：份数、权重和、时点分布必须严格自洽（权重和=1，末片吃掉尾差，总量不多不少）；
 * - VWAP 权重必须跟随历史量能分布，且**不使用未来数据**；
 * - 拆单只改执行不改信号：总成交量、总方向与不拆时完全一致；
 * - 拆单降低总冲击成本（平方根定律），且这一点在关闭冲击模型时必须**不成立**（不许吹收益）；
 * - 实施短缺（bps）可手工核对。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SLICING,
  createSlicedOrder,
  implementationShortfallBps,
  isDone,
  normalizeSlicing,
  planSlices,
  recordSliceFill,
  remainingQuantity,
  takeDueSlice,
  vwapWeights,
} from "../src/execution/slicer.js";
import { PaperBroker, barsPerDayFor } from "../src/execution/paperBroker.js";
import { EventBus, Topic } from "../src/core/eventBus.js";
import { PriceBook } from "../src/data/streaming.js";
import type { Bar, Fill, OrderIntent } from "../src/core/types.js";

function bar(symbol: string, close: number, volume = 100, minutesAgo = 0): Bar {
  return {
    symbol,
    timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, 0) - minutesAgo * 60_000),
    open: close,
    high: close,
    low: close,
    close,
    volume,
  };
}

function intent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    symbol: "X",
    side: "BUY",
    quantity: 10,
    price: 100,
    timestamp: new Date(),
    reason: "test",
    ...overrides,
  };
}

test("切片参数：越界值收敛到安全范围，而不是抛错", () => {
  assert.deepEqual(normalizeSlicing({ algo: "nonsense" as never, slices: 4, sliceSpacingBars: 1 }), {
    algo: "none",
    slices: 4,
    sliceSpacingBars: 1,
    volumeProfileBars: 20,
  });
  const small = normalizeSlicing({ algo: "twap", slices: 0, sliceSpacingBars: -3 });
  assert.equal(small.slices, 1, "0 片应归一为 1（= 不拆）");
  assert.equal(small.sliceSpacingBars, 1, "间隔至少 1 根");
  const big = normalizeSlicing({ algo: "vwap", slices: 999, sliceSpacingBars: 1000 });
  assert.equal(big.slices, 24, "片数上限 24");
  assert.equal(big.sliceSpacingBars, 24);
  assert.deepEqual(normalizeSlicing(undefined), DEFAULT_SLICING);
});

test("TWAP：等量、等间隔、权重和为 1", () => {
  const plan = planSlices({ ...DEFAULT_SLICING, algo: "twap", slices: 4, sliceSpacingBars: 2 });
  assert.equal(plan.length, 4);
  assert.deepEqual(
    plan.map((p) => p.barOffset),
    [0, 2, 4, 6],
  );
  for (const p of plan) assert.ok(Math.abs(p.weight - 0.25) < 1e-12);
  const sum = plan.reduce((a, p) => a + p.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12, `权重和应为 1，实际 ${sum}`);
});

test("none / 单片：只出一片、权重 1、当根成交", () => {
  for (const plan of [
    planSlices({ ...DEFAULT_SLICING, algo: "none", slices: 8 }),
    planSlices({ ...DEFAULT_SLICING, algo: "twap", slices: 1 }),
  ]) {
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.weight, 1);
    assert.equal(plan[0]!.barOffset, 0);
  }
});

test("VWAP：权重跟随历史量能分布，权重和为 1", () => {
  // 历史量能前段清淡、后段活跃（2 片，每片聚合 2 根）
  const profile = [10, 10, 100, 200];
  const weights = vwapWeights(profile, 2, 1);
  assert.ok(weights, "有量能时应给出权重");
  assert.equal(weights.length, 2);
  assert.ok(Math.abs(weights.reduce((a, b) => a + b, 0) - 1) < 1e-12, "权重和应为 1");
  assert.ok(weights[1]! > weights[0]!, `后段量能更高，权重应更大：${JSON.stringify(weights)}`);

  const plan = planSlices({ ...DEFAULT_SLICING, algo: "vwap", slices: 2, sliceSpacingBars: 1 }, profile);
  assert.equal(plan.length, 2);
  assert.ok(Math.abs(plan.reduce((a, p) => a + p.weight, 0) - 1) < 1e-12);
  assert.ok(plan[1]!.weight > plan[0]!.weight, "VWAP 应把更多量放在活跃时段");
});

test("VWAP：量能缺失/全零/过度集中时退回等量，不产出畸形权重", () => {
  assert.equal(vwapWeights([], 3), null);
  assert.equal(vwapWeights([0, 0, 0], 3), null);
  assert.equal(vwapWeights([-1, 2], 2), null, "负成交量无效");
  assert.equal(vwapWeights([5, 0, 0, 0], 2), null, "量能全部集中在一格时应退化而不是给 100% 权重");

  const plan = planSlices({ ...DEFAULT_SLICING, algo: "vwap", slices: 3, sliceSpacingBars: 1 });
  assert.equal(plan.length, 3, "无量能数据时 VWAP 退化为等量 3 片");
  for (const p of plan) assert.ok(Math.abs(p.weight - 1 / 3) < 1e-12);
});

test("切片推进：到期才成交，且全部切片的数量恰好等于总量", () => {
  const order = createSlicedOrder({
    id: "o1",
    symbol: "X",
    side: "BUY",
    quantity: 10,
    price: 100,
    options: { ...DEFAULT_SLICING, algo: "twap", slices: 4, sliceSpacingBars: 2 },
    barIndex: 0,
  });

  // 时点：第 0 片当根成交；间隔内不成交；到点才成交
  assert.ok(takeDueSlice(order, 0), "第 0 片应在第一根成交");
  assert.equal(takeDueSlice(order, 1), null, "间隔内不该成交");
  assert.ok(takeDueSlice(order, 2), "到点应成交");
  assert.equal(takeDueSlice(order, 3), null, "间隔内不该成交");
  assert.ok(takeDueSlice(order, 4));
  const last = takeDueSlice(order, 6);
  assert.ok(last, "最后一片应在第 6 根成交");
  assert.ok(isDone(order));
  assert.equal(takeDueSlice(order, 7), null, "全部完成后不应再成交");

  // 数量精确：四片之和必须恰好等于下单量，逐片记账后剩余为 0
  let planned = 0;
  const sized = createSlicedOrder({
    id: "o1b",
    symbol: "X",
    side: "BUY",
    quantity: 10,
    price: 100,
    options: { ...DEFAULT_SLICING, algo: "twap", slices: 4, sliceSpacingBars: 2 },
    barIndex: 0,
  });
  for (let bar = 0; bar <= 6; bar++) {
    const s = takeDueSlice(sized, bar);
    if (s) {
      planned += s.quantity;
      recordSliceFill(sized, { quantity: s.quantity, price: 100, fee: 0 });
    }
  }
  assert.ok(Math.abs(planned - 10) < 1e-12, `四片之和应恰好等于 10，实际 ${planned}`);
  assert.ok(Math.abs(remainingQuantity(sized)) < 1e-12, `记账后剩余应为 0，实际 ${remainingQuantity(sized)}`);
  assert.ok(Math.abs(sized.filledQuantity - 10) < 1e-12);

  // 除不尽的尾数：末片吃掉尾差，总量仍然精确
  const weird = createSlicedOrder({
    id: "o2",
    symbol: "X",
    side: "SELL",
    quantity: 1,
    price: 100,
    options: { ...DEFAULT_SLICING, algo: "twap", slices: 3, sliceSpacingBars: 1 },
    barIndex: 0,
  });
  let filled = 0;
  for (let bar = 0; bar <= 2; bar++) {
    const s = takeDueSlice(weird, bar);
    if (s) {
      filled += s.quantity;
      recordSliceFill(weird, { quantity: s.quantity, price: 100, fee: 0 });
    }
  }
  assert.ok(Math.abs(filled - 1) < 1e-12, `三片之和应恰好等于 1，实际 ${filled}`);
  assert.ok(isDone(weird));
});

test("实施短缺：可手工核对的 bps（漂移 + 手续费）", () => {
  const order = createSlicedOrder({
    id: "o3",
    symbol: "X",
    side: "BUY",
    quantity: 2,
    price: 100,
    options: { ...DEFAULT_SLICING, algo: "twap", slices: 2, sliceSpacingBars: 1 },
    barIndex: 0,
  });
  // 两片各 1 股：成交价 101，手续费 0.01/股
  recordSliceFill(order, { quantity: 1, price: 101, fee: 0.01 });
  recordSliceFill(order, { quantity: 1, price: 101, fee: 0.01 });
  assert.ok(Math.abs(order.averageFillPrice - 101) < 1e-12);
  // 漂移 (101-100)/100 = 100bps；手续费 0.02/200 = 1bps
  assert.ok(Math.abs(implementationShortfallBps(order) - 101) < 1e-6, `实际 ${implementationShortfallBps(order)}`);

  // 实施短缺恒为「代价」口径：正数 = 多付，负数 = 省下。
  // 卖出方向：成交价低于参考价 = 多付（正），高于参考价 = 省下（负）。
  const sell = createSlicedOrder({
    id: "o4",
    symbol: "X",
    side: "SELL",
    quantity: 1,
    price: 100,
    options: DEFAULT_SLICING,
    barIndex: 0,
  });
  recordSliceFill(sell, { quantity: 1, price: 99, fee: 0 });
  assert.ok(Math.abs(implementationShortfallBps(sell) - 100) < 1e-6, `实际 ${implementationShortfallBps(sell)}`);
  const sellGood = createSlicedOrder({
    id: "o5",
    symbol: "X",
    side: "SELL",
    quantity: 1,
    price: 100,
    options: DEFAULT_SLICING,
    barIndex: 0,
  });
  recordSliceFill(sellGood, { quantity: 1, price: 101, fee: 0 });
  assert.ok(implementationShortfallBps(sellGood) < 0, `卖得比参考价高应是负短缺，实际 ${implementationShortfallBps(sellGood)}`);
});

test("barsPerDayFor：间隔字符串折算成每日根数", () => {
  assert.equal(barsPerDayFor("1m"), 1440);
  assert.equal(barsPerDayFor("5m"), 288);
  assert.equal(barsPerDayFor("1h"), 24);
  assert.equal(barsPerDayFor("1d"), 1);
  assert.equal(barsPerDayFor("1w"), 168);
  assert.equal(barsPerDayFor("30s"), 2880);
  assert.equal(barsPerDayFor(undefined), 1440);
  assert.equal(barsPerDayFor("看不懂"), 1440, "认不出来的间隔退回 1m，不崩");
});

/** 收集一段回放里所有成交。 */
function collect(bus: EventBus): Fill[] {
  const fills: Fill[] = [];
  bus.subscribe<Fill>(Topic.FILL, (e) => fills.push(e.payload));
  return fills;
}

/** 回放 n 根 K 线（收盘价固定、量能固定）。 */
async function pump(bus: EventBus, n: number, close = 100, volume = 1000): Promise<void> {
  for (let i = 0; i < n; i++) {
    await bus.publishAsync(Topic.BAR, bar("X", close, volume));
  }
}

test("PaperBroker 拆单：总量、方向不变，但分片成交", async () => {
  const bus = new EventBus();
  const book = new PriceBook();
  const broker = new PaperBroker(bus, book, {
    feeRate: 0,
    slippageBps: 5,
    slicing: { algo: "twap", slices: 4, sliceSpacingBars: 1 },
  });
  const fills = collect(bus);

  book.update(bar("X", 100));
  await broker.handle(intent({ quantity: 10 }));
  assert.equal(fills.length, 1, "首片应立即成交");
  await pump(bus, 1);
  assert.equal(fills.length, 2);
  await pump(bus, 1);
  assert.equal(fills.length, 3);
  await pump(bus, 1);
  assert.equal(fills.length, 4, "第 4 片应在下单后第 3 根成交");
  await pump(bus, 3);
  assert.equal(fills.length, 4, "全部完成后不应再产生成交");

  const totalQty = fills.reduce((a, f) => a + f.order.quantity, 0);
  assert.ok(Math.abs(totalQty - 10) < 1e-12, `总成交量应等于 10，实际 ${totalQty}`);
  assert.ok(fills.every((f) => f.order.side === "BUY"), "方向不变");
  assert.ok(fills.every((f) => f.order.symbol === "X"));
  for (const f of fills) assert.ok(f.order.quantity > 0, "每片数量都应为正");
  assert.equal(broker.pendingOrders().length, 0, "全部完成后不应有挂着的订单");
  assert.equal(broker.completedOrders().length, 1);
  const done = broker.completedOrders()[0]!;
  assert.equal(done.slices, 4);
  assert.equal(done.slicesDone, 4);
  assert.ok(Math.abs(done.filledQuantity - 10) < 1e-12);
});

/**
 * 跑一遍并返回总滑点成本（成交额 - 按参考价计算的名义金额，正数 = 多付）。
 * quantity 决定订单占市场成交额的比例（参与率），这是拆单能否省钱的关键变量。
 */
async function slippageCost(
  slicing: { algo: "none" } | { algo: "twap"; slices: number; sliceSpacingBars: number },
  quantity: number,
  impactK = 0.35,
): Promise<number> {
  const bus = new EventBus();
  const book = new PriceBook();
  const broker = new PaperBroker(bus, book, {
    feeRate: 0,
    slippageBps: 2,
    impactK,
    interval: "1h",
    slicing,
  });
  const fills = collect(bus);

  // 先喂 30 根有波动、有成交额的行情，让冲击模型拿到统计
  let price = 100;
  for (let i = 0; i < 30; i++) {
    price *= 1 + (((i % 5) - 2) / 100);
    book.update(bar("X", price, 5000));
    await bus.publishAsync(Topic.BAR, bar("X", price, 5000));
  }
  if (impactK > 0) {
    const stats = broker.microStats("X");
    assert.ok(stats && stats.dailyTurnover > 0 && stats.volatility > 0, "冲击模型的行情特征应可用（此前从未接线）");
  }

  book.update(bar("X", 100, 5000));
  await broker.handle(intent({ quantity, price: 100 }));
  await pump(bus, 12, 100, 5000);
  assert.ok(fills.length > 0, "应有成交");
  return fills.reduce((a, f) => a + f.order.quantity * (f.price - 100), 0);
}

test("PaperBroker 拆单：大单（高参与率）拆 4 片显著降低总冲击，且降幅符合平方根量级", async () => {
  // 日均成交额 = 5000 股 × 100 元 × 24 根/日 = 1200 万；下单 2.4 万股 = 240 万元 ≈ 20% 参与率
  const qty = 24_000;
  const whole = await slippageCost({ algo: "none" }, qty);
  const sliced = await slippageCost({ algo: "twap", slices: 4, sliceSpacingBars: 1 }, qty);
  assert.ok(whole > 0, `一次性买入应付出正滑点，实际 ${whole}`);
  const ratio = sliced / whole;
  assert.ok(
    ratio < 0.8,
    `拆 4 片应显著降低总冲击：一次性=${whole.toFixed(4)} 拆单=${sliced.toFixed(4)}（比值 ${ratio.toFixed(3)}）`,
  );
  // 冲击部分按 1/√4 = 1/2 下降，但每片都要重付一次基础点差，所以总比值略高于 1/2
  assert.ok(ratio > 0.5 && ratio < 0.85, `降幅应在平方根量级附近，实际比值 ${ratio.toFixed(3)}`);
});

test("PaperBroker 拆单：省下来的钱随订单规模放大（小单省得没有意义，大单才值得拆）", async () => {
  // 基础点差按金额比例计费，所以拆单**不会**额外增加点差成本；
  // 省下的全部来自冲击项，而冲击 ∝ 参与率 → 绝对省额随订单金额放大。
  const smallQty = 10; // 1000 元，参与率约 0.008%
  const largeQty = 24_000; // 240 万元，参与率约 20%
  const sWhole = await slippageCost({ algo: "none" }, smallQty);
  const sSliced = await slippageCost({ algo: "twap", slices: 4, sliceSpacingBars: 1 }, smallQty);
  const lWhole = await slippageCost({ algo: "none" }, largeQty);
  const lSliced = await slippageCost({ algo: "twap", slices: 4, sliceSpacingBars: 1 }, largeQty);

  assert.ok(sSliced < sWhole, `小单也应略有节省：${sWhole.toFixed(6)} -> ${sSliced.toFixed(6)}`);
  assert.ok(lSliced < lWhole, `大单应节省：${lWhole.toFixed(2)} -> ${lSliced.toFixed(2)}`);

  const saveSmall = sWhole - sSliced;
  const saveLarge = lWhole - lSliced;
  // 绝对省额：大单比小单高两个数量级以上（金额放大 240 倍 × 参与率放大）
  assert.ok(
    saveLarge > saveSmall * 100,
    `大单省的钱应远多于小单：${saveSmall.toFixed(6)} vs ${saveLarge.toFixed(4)}`,
  );
});

test("PaperBroker 拆单：关闭冲击模型后拆单不产生任何「收益」", async () => {
  const noImpactWhole = await slippageCost({ algo: "none" }, 24_000, 0);
  const noImpactSliced = await slippageCost({ algo: "twap", slices: 4, sliceSpacingBars: 1 }, 24_000, 0);
  assert.ok(
    Math.abs(noImpactSliced - noImpactWhole) < 1e-6,
    `无冲击模型时总成本必须相同（都是 n × 基础点差）：${noImpactSliced} vs ${noImpactWhole}`,
  );
});

test("PaperBroker 拆单：关闭时行为与不拆完全一致（单笔成交）", async () => {
  const bus = new EventBus();
  const book = new PriceBook();
  const broker = new PaperBroker(bus, book, {
    feeRate: 0.001,
    slippageBps: 10,
    slicing: { algo: "none", slices: 8 },
  });
  const fills = collect(bus);
  book.update(bar("X", 100));
  const fill = await broker.handle(intent({ quantity: 1 }));
  await pump(bus, 5);
  assert.equal(fills.length, 1, "关闭拆单时只应有一笔成交");
  assert.ok(fill);
  // 滑点 +10bps -> 100.1；手续费 0.1%
  assert.ok(Math.abs(fill.price - 100.1) < 1e-9);
  assert.ok(Math.abs(fill.fee - 100.1 * 0.001) < 1e-9);
  assert.equal(broker.pendingOrders().length, 0);
});

test("PaperBroker 拆单：VWAP 用历史量能定权重，绝不使用未来量", async () => {
  const bus = new EventBus();
  const book = new PriceBook();
  const broker = new PaperBroker(bus, book, {
    feeRate: 0,
    slippageBps: 0,
    slicing: { algo: "vwap", slices: 2, sliceSpacingBars: 1, volumeProfileBars: 20 },
  });

  // 历史量能：前段活跃、后段清淡
  for (let i = 0; i < 10; i++) {
    const volume = i < 5 ? 1000 : 100;
    book.update(bar("X", 100, volume));
    await bus.publishAsync(Topic.BAR, bar("X", 100, volume));
  }

  const seen: number[] = [];
  bus.subscribe<Fill>(Topic.FILL, (e) => seen.push(e.payload.order.quantity));

  book.update(bar("X", 100, 100));
  await broker.handle(intent({ quantity: 12 }));
  await pump(bus, 3, 100, 100);
  // 首片权重来自历史分布，应显著大于次片
  const sizes = [...seen];
  assert.equal(sizes.length, 2);
  assert.ok(sizes[0]! > sizes[1]! * 3, `前段活跃，首片应明显更大：${JSON.stringify(sizes)}`);
  assert.ok(Math.abs(sizes.reduce((a, b) => a + b, 0) - 12) < 1e-12, "总量必须恰好等于下单量");
});