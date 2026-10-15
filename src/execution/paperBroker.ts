/**
 * 模拟券商：按最新价 ± 滑点立即成交，收取手续费。
 *
 * 滑点走冲击成本模型（随订单规模与标的波动变化），而不是一个固定 bps；
 * 没有足够行情数据时自动退回固定滑点。
 *
 * 开启 execution.slicing 后（TWAP/VWAP），一笔订单会被拆成若干子单分时成交：
 * 每片各自按自己的金额算冲击成本，所以总冲击成本低于一次性吃掉全部流动性，
 * 代价是承担拆单期间的价格漂移（由 implementationShortfallBps 统计，可核对）。
 * 默认 algo = "none"，行为与开启前完全一致。
 */

import { EventBus, Topic } from "../core/eventBus.js";
import type { Bar, Fill, OrderIntent } from "../core/types.js";
import type { PriceBook } from "../data/streaming.js";
import { getLogger } from "../core/logger.js";
import type { Broker } from "./broker.js";
import { CostModel, DEFAULT_IMPACT, dailyTurnover, realizedVolatility, type MarketMicroStats } from "../cost/impactModel.js";
import {
  createSlicedOrder,
  implementationShortfallBps,
  isDone,
  normalizeSlicing,
  recordSliceFill,
  takeDueSlice,
  type SlicedOrder,
  type SlicingOptions,
} from "./slicer.js";

const log = getLogger("broker:paper");

export interface PaperBrokerOptions {
  feeRate: number;
  /** 基础滑点（bps）：冲击模型的固定分量 */
  slippageBps: number;
  /** 冲击系数（0 = 只用固定滑点，保持旧行为） */
  impactK?: number;
  maxSlippageBps?: number;
  /** 拆单执行（默认 none = 不拆） */
  slicing?: Partial<SlicingOptions>;
  /** K 线间隔（如 1m / 5m / 1h），用于把「每根波动」折算成日频口径 */
  interval?: string;
}

export interface SlicedOrderReport {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  filledQuantity: number;
  slices: number;
  slicesDone: number;
  referencePrice: number;
  averageFillPrice: number;
  fee: number;
  /** 实施短缺（bps，正 = 拆单多付，负 = 省下） */
  shortfallBps: number;
  pending: boolean;
}

/**
 * 由 K 线间隔推出每天多少根（7×24 = 168 小时为加密市场惯例）。
 * 认不出来时按 1m 处理，并把推测值如实反映在成本口径里。
 */
export function barsPerDayFor(interval: string | undefined): number {
  const m = /^(\d+)\s*([smhdw])$/i.exec((interval ?? "1m").trim());
  if (!m) return 1440;
  const step = Number(m[1]) || 1;
  const unit = m[2]!.toLowerCase();
  const perDay = unit === "s" ? 86400 : unit === "m" ? 1440 : unit === "h" ? 24 : unit === "d" ? 1 : 168;
  return Math.max(1, Math.round(perDay / step));
}

function report(order: SlicedOrder, pending: boolean): SlicedOrderReport {
  return {
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    quantity: order.totalQuantity,
    filledQuantity: order.filledQuantity,
    slices: order.plan.length,
    slicesDone: order.next,
    referencePrice: order.referencePrice,
    averageFillPrice: order.averageFillPrice,
    fee: order.fee,
    shortfallBps: implementationShortfallBps(order),
    pending,
  };
}

export class PaperBroker implements Broker {
  readonly name = "paper";
  readonly paper = true;

  private readonly cost: CostModel;
  private readonly slicing: SlicingOptions;
  private readonly slicingOn: boolean;
  private readonly pending = new Map<string, SlicedOrder>();
  private readonly completed: SlicedOrderReport[] = [];
  private seq = 0;
  /** 已推进的 K 线根数：拆单进度以它为时钟 */
  private barIndex = 0;
  private readonly volumeHistory = new Map<string, number[]>();
  /** 每个标的的近期 K 线（收盘价 + 成交量），供冲击成本模型估算波动与成交额 */
  private readonly barWindows = new Map<string, { close: number; volume: number }[]>();
  private readonly windowBars: number;
  private readonly barsPerDay: number;

  constructor(
    private readonly bus: EventBus,
    private readonly book: PriceBook,
    private readonly opts: PaperBrokerOptions,
  ) {
    this.cost = new CostModel({
      baseBps: opts.slippageBps,
      k: opts.impactK ?? 0,
      maxBps: opts.maxSlippageBps ?? DEFAULT_IMPACT.maxBps,
      windowBars: DEFAULT_IMPACT.windowBars,
    });
    this.slicing = normalizeSlicing(opts.slicing);
    this.windowBars = DEFAULT_IMPACT.windowBars;
    this.barsPerDay = barsPerDayFor(opts.interval);
    this.slicingOn = this.slicing.algo !== "none" && this.slicing.slices > 1;

    // 冲击成本模型必须真的接上行情特征，否则 k 永远为 0、成本层等于摆设。
    // 这里自行维护每个标的的 K 线窗口，避免要求上游额外提供统计。
    this.setMicroStats((symbol) => this.estimateMicroStats(symbol));

    // 拆单状态机：每根 K 线推进一次，仅此一个时钟。
    // 行情窗口无论如何都要维护（冲击成本模型靠它），所以这条订阅是常开的。
    this.bus.subscribe<Bar>(Topic.BAR, (e) => this.onBar(e.payload));
    if (this.slicingOn) {
      log.info(
        "拆单执行已开启：%s，%s 片，间隔 %s 根",
        this.slicing.algo.toUpperCase(),
        this.slicing.slices,
        this.slicing.sliceSpacingBars,
      );
    }
  }

  /** 由行情缓冲喂入的交易特征；没有它就走固定滑点。 */
  setMicroStats(getter: (symbol: string) => MarketMicroStats | undefined): void {
    this.micro = getter;
  }

  private micro: ((symbol: string) => MarketMicroStats | undefined) | null = null;

  async handle(intent: OrderIntent): Promise<Fill | null> {
    const price = this.book.last(intent.symbol);
    if (price === undefined || !(intent.quantity > 0)) {
      log.warn("无行情或数量为 0，订单被驳回: %s", intent.symbol);
      this.bus.publish(Topic.ORDER_REJECTED, intent);
      return null;
    }
    if (!this.slicingOn) return this.fillWholeOrder(intent, price);

    const id = `${intent.symbol}-${this.seq++}`;
    const order = createSlicedOrder({
      id,
      symbol: intent.symbol,
      side: intent.side,
      quantity: intent.quantity,
      price,
      options: this.slicing,
      barIndex: this.barIndex,
      volumeProfile: this.trailingVolumes(intent.symbol),
    });
    this.pending.set(id, order);
    log.info(
      "PAPER 拆单 %s %s %s → %s 片（%s），首片立即成交",
      order.side,
      order.symbol,
      order.totalQuantity.toFixed(6),
      order.plan.length,
      this.slicing.algo.toUpperCase(),
    );
    const fill = this.executeDueSlice(order, intent);
    if (isDone(order)) {
      this.pending.delete(id);
      this.pushCompleted(report(order, false));
    }
    return fill;
  }

  /** 一次性全部成交（未开拆单时的原有行为，逐字保持）。 */
  private fillWholeOrder(intent: OrderIntent, mid: number): Fill {
    const stats = this.micro?.(intent.symbol);
    const bps = this.cost.slippageBps(intent.quantity * mid, stats);
    const execPrice = this.cost.execPrice(mid, intent.side, bps);
    const notional = intent.quantity * execPrice;
    const fill: Fill = {
      order: intent,
      price: execPrice,
      fee: notional * this.opts.feeRate,
      timestamp: intent.timestamp,
    };
    log.info(
      "PAPER %s %s %s @ %s",
      intent.side,
      intent.symbol,
      intent.quantity.toFixed(6),
      execPrice.toFixed(4),
    );
    this.bus.publish(Topic.FILL, fill);
    return fill;
  }

  /** K 线推进：维护量能/行情窗口、执行到期切片。 */
  private onBar(bar: Bar): void {
    this.recordVolume(bar);
    this.recordWindow(bar);
    this.barIndex += 1;
    if (!this.slicingOn || this.pending.size === 0) return;
    for (const order of [...this.pending.values()]) {
      const due = takeDueSlice(order, this.barIndex);
      if (!due) continue;
      this.executeDueSlice(order, undefined, due);
      if (isDone(order)) {
        this.pending.delete(order.id);
        this.pushCompleted(report(order, false));
      }
    }
  }

  /** 执行当前到期的那一片，并广播子单成交。 */
  private executeDueSlice(
    order: SlicedOrder,
    intent?: OrderIntent,
    due?: { quantity: number; barOffset: number },
  ): Fill | null {
    const slice = due ?? takeDueSlice(order, this.barIndex);
    if (!slice) return null;
    const mid = this.book.last(order.symbol);
    if (mid === undefined || !(slice.quantity > 0)) {
      log.warn("拆单切片无行情，暂缓: %s", order.symbol);
      return null;
    }

    const stats = this.micro?.(order.symbol);
    // 每片按自己的金额单独算冲击：拆单省成本的来源就在这一行
    const bps = this.cost.slippageBps(slice.quantity * mid, stats);
    const execPrice = this.cost.execPrice(mid, order.side, bps);
    const notional = slice.quantity * execPrice;
    const fee = notional * this.opts.feeRate;

    const sliceOrder: OrderIntent = {
      symbol: order.symbol,
      side: order.side,
      quantity: slice.quantity,
      price: mid,
      timestamp: intent?.timestamp ?? new Date(),
      reason: intent ? intent.reason : `slice_${order.next - 1 + 1}/${order.plan.length}`,
    };
    recordSliceFill(order, { quantity: slice.quantity, price: execPrice, fee });

    const fill: Fill = { order: sliceOrder, price: execPrice, fee, timestamp: sliceOrder.timestamp };
    log.debug(
      "PAPER 切片 %s %s %s @ %s（累计 %s / %s）",
      order.side,
      order.symbol,
      slice.quantity.toFixed(6),
      execPrice.toFixed(4),
      order.filledQuantity.toFixed(6),
      order.totalQuantity.toFixed(6),
    );
    this.bus.publish(Topic.FILL, fill);
    return fill;
  }

  private recordVolume(bar: Bar): void {
    const list = this.volumeHistory.get(bar.symbol) ?? [];
    list.push(bar.volume);
    if (list.length > this.slicing.volumeProfileBars) list.shift();
    this.volumeHistory.set(bar.symbol, list);
  }

  /** 滚动保存收盘价与成交量：波动率、成交额、VWAP 权重都从这里算。 */
  private recordWindow(bar: Bar): void {
    const list = this.barWindows.get(bar.symbol) ?? [];
    list.push({ close: bar.close, volume: bar.volume });
    if (list.length > this.windowBars) list.shift();
    this.barWindows.set(bar.symbol, list);
  }

  /** 用已观测的 K 线估算波动率与日均成交额；样本不足时返回 undefined（退回固定滑点）。 */
  private estimateMicroStats(symbol: string): MarketMicroStats | undefined {
    const bars = this.barWindows.get(symbol);
    if (!bars || bars.length < 3) return undefined;
    const volatility = realizedVolatility(
      bars.map((b) => b.close),
      this.barsPerDay,
    );
    const turnover = dailyTurnover(bars, this.barsPerDay);
    if (!(volatility > 0) || !(turnover > 0)) return undefined;
    return { volatility, dailyTurnover: turnover };
  }

  /** 当前生效的交易特征（面板/测试用；样本不足时为 undefined）。 */
  microStats(symbol: string): MarketMicroStats | undefined {
    return this.micro?.(symbol) ?? undefined;
  }

  /**
   * 取该标的**已观测到**的成交量。绝不使用下单时刻之后的量能 ——
   * VWAP 权重因此来自历史量能曲线，这是实盘真实可得的信息（用未来量能就是前视偏差）。
   */
  private trailingVolumes(symbol: string): number[] | undefined {
    const list = this.volumeHistory.get(symbol);
    return list && list.length > 0 ? [...list] : undefined;
  }

  private pushCompleted(r: SlicedOrderReport): void {
    this.completed.push(r);
    if (this.completed.length > 200) this.completed.shift();
  }

  /** 拆单执行状态；没开拆单时返回 null（面板据此隐藏统计，不显示一堆 0）。 */
  slicingState(): { algo: "none" | "twap" | "vwap"; slices: number; pending: SlicedOrderReport[]; completed: SlicedOrderReport[] } | null {
    if (!this.slicingOn) return null;
    return {
      algo: this.slicing.algo,
      slices: this.slicing.slices,
      pending: this.pendingOrders(),
      completed: this.completedOrders(),
    };
  }

  /** 未完成的拆单（面板用）。 */
  pendingOrders(): SlicedOrderReport[] {
    return [...this.pending.values()].map((o) => report(o, true));
  }

  /** 本次运行已完成的拆单（面板用）。 */
  completedOrders(): SlicedOrderReport[] {
    return this.completed.map((o) => ({ ...o }));
  }
}