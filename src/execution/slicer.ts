/**
 * 执行算法（TWAP / VWAP）：把一笔大单拆成若干子单，分散到不同时间成交。
 *
 * 为什么要拆：冲击成本随「订单占市场成交额的比例」按平方根上升
 * （见 cost/impactModel.ts 的 Almgren-Chriss 近似）。
 * 同样的金额拆成 n 片分时执行，每片占比变成 1/n，总冲击约降到 1/√n。
 * 这是实盘大单必须拆的原因，也是「回测里一次性成交」会系统性低估成本的原因。
 *
 * 两种经典算法：
 * - TWAP：按时间等量切片（不管市场什么时候活跃）
 * - VWAP：按成交量分布分配（尽量在活跃时段成交）
 *
 * 三条诚实边界：
 * 1. **不看未来数据**：VWAP 的权重来自「过去若干根 K 线的成交量分布」（历史量能曲线），
 *    绝不使用下单时刻之后的真实成交量 —— 否则就是典型的前视偏差，回测会好看得离谱。
 * 2. **拆单只改执行，不改信号**：拆成几片都会把整笔单执行完，不会因为拆单而少买少卖。
 * 3. **默认关闭**（execution.slicing.algo = none），保证既有回测/实盘行为完全不变。
 */

import { getLogger } from "../core/logger.js";

const log = getLogger("execution:slicer");

export type SlicingAlgo = "none" | "twap" | "vwap";

export interface SlicingOptions {
  algo: SlicingAlgo;
  /** 拆成几片（1 ≤ slices ≤ 24） */
  slices: number;
  /** 相邻两片间隔几根 K 线（≥1） */
  sliceSpacingBars: number;
  /** VWAP 权重所用的历史成交量窗口长度（根） */
  volumeProfileBars: number;
}

export const DEFAULT_SLICING: SlicingOptions = {
  algo: "none",
  slices: 4,
  sliceSpacingBars: 1,
  volumeProfileBars: 20,
};

export interface SlicePlan {
  /** 第 i 片相对下单那根 K 线延后几根执行（0 = 当根） */
  barOffset: number;
  /** 该片的金额占比（全部相加 = 1） */
  weight: number;
}

/** 规范化切片参数，越界值收敛到安全范围而不是抛错。 */
export function normalizeSlicing(options?: Partial<SlicingOptions> | undefined): SlicingOptions {
  const merged = { ...DEFAULT_SLICING, ...(options ?? {}) };
  const algo: SlicingAlgo =
    merged.algo === "twap" || merged.algo === "vwap" ? merged.algo : merged.algo === "none" ? "none" : "none";
  const slices = Number.isFinite(merged.slices) ? Math.max(1, Math.min(24, Math.floor(merged.slices))) : 4;
  const sliceSpacingBars = Number.isFinite(merged.sliceSpacingBars)
    ? Math.max(1, Math.min(24, Math.floor(merged.sliceSpacingBars)))
    : 1;
  const volumeProfileBars = Number.isFinite(merged.volumeProfileBars)
    ? Math.max(1, Math.min(200, Math.floor(merged.volumeProfileBars)))
    : 20;
  return { algo, slices, sliceSpacingBars, volumeProfileBars };
}

/**
 * 生成切片计划。
 *
 * @param options 切片参数
 * @param volumeProfile **历史**成交量序列（最新的一根在最后）。只用于 VWAP 定权重，
 *                     且必须是下单时刻之前已观测到的量；缺数据时退化为等量切片。
 */
export function planSlices(options: SlicingOptions, volumeProfile?: number[]): SlicePlan[] {
  const { algo, slices: rawSlices, sliceSpacingBars: rawSpacing } = normalizeSlicing(options);
  const n = rawSlices;
  const spacing = rawSpacing;

  if (algo === "none" || n === 1) return [{ barOffset: 0, weight: 1 }];

  if (algo === "vwap" && volumeProfile && volumeProfile.length > 0) {
    const weights = vwapWeights(volumeProfile, n, spacing);
    if (weights) {
      return weights.map((weight, i) => ({ barOffset: i * spacing, weight }));
    }
  }

  const equal = 1 / n;
  return Array.from({ length: n }, (_, i) => ({ barOffset: i * spacing, weight: equal }));
}

/**
 * 由历史量能曲线推出每片的成交占比。
 *
 * 做法：把历史窗口切成 n 段（段长 = spacing），每段的成交量之和作为该片的权重。
 * 历史量能通常日内呈 U 型，因此这个权重会自然地让订单更集中于活跃时段 —— 这正是 VWAP 的目的。
 * 返回 null 表示历史量能不可用（全 0 或空），此时调用方退化为等量切片。
 */
export function vwapWeights(volumeProfile: number[], slices: number, spacing = 1): number[] | null {
  const n = Math.max(1, Math.floor(slices));
  const positive = volumeProfile.filter((v) => Number.isFinite(v) && v > 0);
  if (positive.length === 0) return null;

  const span = Math.max(1, Math.floor(spacing)) * n;
  // 历史不足时按比例拉伸到 n 段（保持相对量能结构）
  const step = volumeProfile.length / span;
  const buckets = new Array<number>(n).fill(0);
  for (let i = 0; i < volumeProfile.length; i++) {
    const v = volumeProfile[i]!;
    if (!Number.isFinite(v) || v <= 0) continue;
    const bucket = Math.min(n - 1, Math.floor(i / step));
    buckets[bucket] = buckets[bucket]! + v;
  }
  const total = buckets.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  const weights = buckets.map((b) => b / total);
  // 量能全部集中在某一格时，退化为等量（避免单片吃掉 100%）
  if (Math.max(...weights) > 0.95) return null;
  return weights;
}

/** 一笔被拆单的父订单的执行进度。 */
export interface SlicedOrder {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  totalQuantity: number;
  /** 下单时的参考价（用于算实施短缺） */
  referencePrice: number;
  plan: SlicePlan[];
  /** 下一片的下标 */
  next: number;
  filledQuantity: number;
  notional: number;
  fee: number;
  /** 加权平均成交价 */
  averageFillPrice: number;
  startedAtBar: number;
  /** 各片实际成交价 */
  fillPrices: number[];
}

/** 创建一笔待执行的拆单（不成交任何一片）。 */
export function createSlicedOrder(args: {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  options: SlicingOptions;
  barIndex: number;
  volumeProfile?: number[];
}): SlicedOrder {
  return {
    id: args.id,
    symbol: args.symbol,
    side: args.side,
    totalQuantity: args.quantity,
    referencePrice: args.price,
    plan: planSlices(args.options, args.volumeProfile),
    next: 0,
    filledQuantity: 0,
    notional: 0,
    fee: 0,
    averageFillPrice: 0,
    startedAtBar: args.barIndex,
    fillPrices: [],
  };
}

export function isDone(order: SlicedOrder): boolean {
  return order.next >= order.plan.length;
}

export function remainingQuantity(order: SlicedOrder): number {
  return Math.max(0, order.totalQuantity - order.filledQuantity);
}

/**
 * 取出当前应当执行的那一片；返回 null 表示这一根还不到执行时点。
 * 数量按剩余量重新归一（最后一片吃掉尾差），保证整笔单不多不少地成交完。
 */
export function takeDueSlice(order: SlicedOrder, barIndex: number): { quantity: number; barOffset: number } | null {
  if (isDone(order)) return null;
  const slice = order.plan[order.next]!;
  if (barIndex < order.startedAtBar + slice.barOffset) return null;

  const remaining = remainingQuantity(order);
  if (remaining <= 1e-12) {
    order.next = order.plan.length;
    return null;
  }
  const isLast = order.next === order.plan.length - 1;
  const quantity = isLast ? remaining : Math.min(remaining, order.totalQuantity * slice.weight);
  order.next += 1;
  return { quantity, barOffset: slice.barOffset };
}

/** 记录一次子单成交，累计加权平均价。 */
export function recordSliceFill(
  order: SlicedOrder,
  args: { quantity: number; price: number; fee: number },
): { averageFillPrice: number; notional: number; fee: number } {
  const notional = args.quantity * args.price;
  order.filledQuantity += args.quantity;
  order.notional += notional;
  order.fee += args.fee;
  order.averageFillPrice = order.filledQuantity > 0 ? order.notional / order.filledQuantity : 0;
  order.fillPrices.push(args.price);
  return { averageFillPrice: order.averageFillPrice, notional: order.notional, fee: order.fee };
}

/**
 * 实施短缺（Implementation Shortfall）：实际成交成本相对「下单即成交」的额外代价，bps。
 * 正数 = 拆单付出的额外代价（价格漂移 + 多付的冲击）；负数 = 拆单省下来的。
 * 用它可以把「拆单到底赚没赚」变成一个可核对的口径，而不是讲故事。
 */
export function implementationShortfallBps(order: SlicedOrder): number {
  if (!(order.referencePrice > 0) || order.filledQuantity <= 0) return 0;
  const dir = order.side === "BUY" ? 1 : -1;
  const driftBps = ((dir * (order.averageFillPrice - order.referencePrice)) / order.referencePrice) * 10_000;
  const feeBps = order.filledQuantity > 0 ? (order.fee / (order.filledQuantity * order.referencePrice)) * 10_000 : 0;
  return Number((driftBps + feeBps).toFixed(4));
}