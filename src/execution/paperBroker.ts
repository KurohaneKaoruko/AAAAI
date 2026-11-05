/**
 * 模拟券商：按**下一根 K 线的开盘价** ± 滑点成交，收取手续费。
 *
 * 成交口径（可信度的地基）：
 * - 决策发生在第 t 根 K 线收盘时（此刻才知道它的收盘价），
 *   所以按第 t 根收盘价立即成交等于假设"看到收盘价还能买在收盘价"——
 *   现实里做不到，回测里就会凭空多出一段利润。
 *   因此订单入队，等**下一根 K 线开盘**才成交；数据结束时还没轮到的订单作废。
 * - 现金账户：买单成交前查可用现金，付不起全额就按付得起的量成交
 *   （买单等价于「把这笔钱投进去」），零头都买不起才拒单 —— 绝不透支。
 *   真实券商不会让你花没有的钱；不设这道线的话，多标的各自满仓会
 *   凭空造出一个 2~3 倍杠杆的模拟账户，大跌时权益能穿成负数。
 *   接了 availableCash 查询才启用这道线（不接 = 旧行为，仅供特殊场景）。
 *
 * 滑点走冲击成本模型（随订单规模与标的波动变化），而不是一个固定 bps；
 * 没有足够行情数据时自动退回固定滑点。
 *
 * 开启 execution.slicing 后（TWAP/VWAP），一笔订单会被拆成若干子单分时成交：
 * 每片各自按自己的金额算冲击成本，所以总冲击成本低于一次性吃掉全部流动性，
 * 代价是承担拆单期间的价格漂移（由 implementationShortfallBps 统计，可核对）。
 * 默认 algo = "none"，行为与开启前完全一致。
 *
 * 盘口撮合模式（setOrderBookProvider 注入后生效，实时模拟盘专用）：
 * 下单瞬间拉取交易所**真实公共盘口**，市价单逐档吃单（见 bookLiquidity.ts），
 * 成交价由真实深度决定、按真实费率表收费、深度不足按 IOC 部分成交——
 * 与真实交易所的市价单行为一致。回测没有历史盘口，仍走下一根开盘价模型。
 */

import { EventBus, Topic } from "../core/eventBus.js";
import type { Bar, Fill, OrderIntent } from "../core/types.js";
import type { PriceBook } from "../data/streaming.js";
import { getLogger } from "../core/logger.js";
import type { Broker } from "./broker.js";
import type { OrderBookSnapshot } from "../exchanges/types.js";
import { fillMarketAgainstBook } from "./bookLiquidity.js";
import { feePairFor, type FeePair } from "./feeSchedule.js";
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
  /**
   * 可用现金查询（现金账户语义）：买单成交前必须付得起「成交额 + 手续费」，
   * 不够就拒单。不接这个查询时行为与从前一致（不检查现金）。
   *
   * 为什么必须有：真实券商不会让你花没有的钱，模拟盘如果默认给无限保证金，
   * 多标的各自满仓（例：5 个标的各 50% = 2.5 倍总敞口）就会在模拟里
   * 凭空造出一个实盘不存在的杠杆账户 —— 大跌时权益甚至能穿成负数。
   */
  availableCash?: () => number;
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
  /**
   * 待成交订单（决策已发出，等下一根 K 线开盘成交）。
   * 同一批订单按入队顺序一起成交，不做优先级排序 —— 保持与真实时间线一致。
   */
  private queued: OrderIntent[] = [];
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

  /**
   * 真实盘口来源（可选）：注入后实时模拟盘的下单走「逐档吃真实盘口」，
   * 不注入则保持「下一根开盘价 + 冲击成本」的回测口径。
   * 注入方负责限频与容错（拉不到盘口时返回 null，broker 自动退回旧口径）。
   */
  setOrderBookProvider(provider: ((symbol: string) => Promise<OrderBookSnapshot | null>) | null): void {
    this.bookProvider = provider;
  }

  private bookProvider: ((symbol: string) => Promise<OrderBookSnapshot | null>) | null = null;

  /**
   * 适配器费率（taker/maker）。注入后取代单一 feeRate：市价单收 taker 费。
   * 未注入时沿用 risk.feeRate（用户显式配置仍然最优先——他知道自己那档费率）。
   */
  setAdapterFees(fees: FeePair | null): void {
    this.adapterFees = fees;
    if (fees) {
      log.info("模拟撮合费率切换为交易所真实费率表：taker %s bps / maker %s bps", (fees.taker * 1e4).toFixed(1), (fees.maker * 1e4).toFixed(1));
    }
  }

  private adapterFees: FeePair | null = null;

  /** 当前生效的吃单费率（市价单 = taker）。 */
  private get takerFee(): number {
    return this.adapterFees?.taker ?? this.opts.feeRate;
  }

  /**
   * 收到订单意图：**不入队即成交**，而是排队等下一根 K 线。
   *
   * 立刻按当前价成交是回测里最常见的伪盈利来源：信号用的是这根 K 线的收盘价，
   * 而按同一个收盘价成交等于假设"知道收盘价还能买在收盘价"。现实中做不到。
   * 所以这里只做校验与入队，真正的成交在 onBar（下一根 K 线开盘价）里完成。
   */
  async handle(intent: OrderIntent): Promise<Fill | null> {
    const price = this.book.last(intent.symbol);
    if (price === undefined || !(intent.quantity > 0)) {
      log.warn("无行情或数量为 0，订单被驳回: %s", intent.symbol);
      this.bus.publish(Topic.ORDER_REJECTED, intent);
      return null;
    }
    // 盘口撮合模式：拉真实盘口立即逐档成交（实时模拟盘专用，见文件头说明）
    if (this.bookProvider) {
      const book = await this.bookProvider(intent.symbol).catch(() => null);
      if (book && book.asks.length > 0 && book.bids.length > 0) {
        return this.fillAgainstBook(intent, book);
      }
      // 盘口拉取失败（限频/网络）：退回 K 线队列口径，绝不静默丢弃订单
      log.warn("%s 盘口不可用，本单退回下一根开盘价口径", intent.symbol);
    }
    if (!this.slicingOn) {
      /**
       * 同一标的只保留最新的未成交订单。
       *
       * 为什么要取代而不是并存：风控是按**组合当前持仓**算调仓量的，
       * 它看不见还没成交的订单。成交延迟一根 K 线时，若每轮决策都叠一单，
       * 这些单会按同一时的持仓各算一次，叠加后把仓位打成反向（凭空做空）——
       * 那是模拟口径自己造出来的仓位，不是策略的决定。
       * 所以新决策取代同标的的旧单：真实交易里也是"撤掉旧单一挂新单"。
       */
      const stale = this.queued.filter((q) => q.symbol === intent.symbol);
      if (stale.length > 0) {
        this.queued = this.queued.filter((q) => q.symbol !== intent.symbol);
        for (const q of stale) {
          log.info("%s 的旧订单被新决策取代（避免叠加出反向仓位）", q.symbol);
          this.bus.publish(Topic.ORDER_REJECTED, q);
        }
      }
      this.queued.push(intent);
      return null;
    }

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
      "PAPER 拆单 %s %s %s → %s 片（%s），按 K 线逐片成交（首片也等下一根 K 线）",
      order.side,
      order.symbol,
      order.totalQuantity.toFixed(6),
      order.plan.length,
      this.slicing.algo.toUpperCase(),
    );
    // 不在这里立即成交：与不拆单时同一口径 —— 决策当根不能成交。
    // 拆单进度由 onBar 每根 K 线推进，首片按计划在后续某根成交。
    return null;
  }

  /**
   * 成交上一根 K 线排下的订单：本根开盘价 ± 滑点。
   *
   * 用开盘价而不是收盘价：开盘价是"这根 K 线开始时就能拿到的价"，
   * 而收盘价要到这根走完才知道 —— 用后者仍是超前信息。
   * 跳空保护：开盘价缺失或明显异常（<=0 或偏离收盘 10 倍以上）就放弃这批订单，
   * 按"没成交"处理，绝不按一个离谱的价格凑出成交。
   */
  private executeQueued(bar: Bar): void {
    if (this.queued.length === 0) return;
    const queue = this.queued;
    this.queued = [];
    const open = bar.open;
    const usable = Number.isFinite(open) && open > 0 && (bar.close <= 0 || open > bar.close / 10) && (open < bar.close * 10);
    if (!usable) {
      log.warn("开盘价不可用（%s open=%s），本批 %d 笔订单作废", bar.symbol, open, queue.length);
      for (const intent of queue) this.bus.publish(Topic.ORDER_REJECTED, intent);
      return;
    }
    for (const intent of queue) {
      if (intent.symbol !== bar.symbol) {
        // 非本标的的订单继续等自己的下一根 K 线
        this.queued.push(intent);
        continue;
      }
      /*
       * 关键防未来函数：订单只能用它之后的下一根 K 线成交。
       * 如果订单和当前 K 线是同一根（尤其策略在 BAR 事件里下单，
       * 而 broker 的 BAR 订阅在策略之后执行），绝对不能用这根的开盘价成交——
       * 那个价格发生在信号之前。保留到下一根，避免回测凭空多出一段利润。
       */
      if (bar.timestamp.getTime() <= intent.timestamp.getTime()) {
        this.queued.push(intent);
        continue;
      }
      this.fillWholeOrder(intent, open, bar.timestamp);
    }
  }

  /**
   * 逐档吃真实盘口成交（实时模拟盘）。
   *
   * 与 fillWholeOrder 的差别：成交价不是「基准价 ± 合成滑点」，而是把
   * 订单真实地吃进盘口——吃到哪一档、均价多少、深度够不够，全由交易所
   * 此刻的真实挂单决定。现金校验仍然前置（付不起就按付得起的量吃），
   * IOC 语义下剩余撤销并广播，让事件流如实反映部分成交。
   */
  private fillAgainstBook(intent: OrderIntent, book: OrderBookSnapshot): Fill | null {
    const result = fillMarketAgainstBook(book, intent.side, intent.quantity);
    if (result.filledQuantity <= 0) {
      log.warn("%s 盘口为空/全量非法，订单被驳回", intent.symbol);
      this.bus.publish(Topic.ORDER_REJECTED, intent);
      return null;
    }
    // 现金账户语义：买单按付得起的量截断（与 fillWholeOrder 同一防线）
    let filled = result.filledQuantity;
    if (intent.side === "BUY") {
      const affordable = this.affordableQuantity(intent, result.averagePrice);
      if (affordable === null) return null;
      filled = Math.min(filled, affordable);
    }
    const notional = filled * result.averagePrice;
    const fee = notional * this.takerFee; // 市价单 = 吃单方
    const fill: Fill = {
      order: filled === intent.quantity ? intent : { ...intent, quantity: filled },
      price: result.averagePrice,
      fee,
      timestamp: new Date(book.timestamp),
    };
    log.info(
      "PAPER 盘口成交 %s %s %s/%s @ %s（吃 %d 档，滑点 %s bps，taker 费 %s%s）",
      intent.side,
      intent.symbol,
      filled.toFixed(6),
      intent.quantity.toFixed(6),
      result.averagePrice.toFixed(6),
      result.levelsConsumed,
      result.slippageBps.toFixed(1),
      fee.toFixed(4),
      result.unfilledQuantity > 0 ? `，剩余 ${result.unfilledQuantity.toFixed(6)} 撤销（IOC）` : "",
    );
    this.bus.publish(Topic.FILL, fill);
    if (result.unfilledQuantity > 0 && filled >= result.filledQuantity) {
      // 市场深度不足导致的未成交部分：广播部分成交语义，让上层与流水对得上
      this.bus.publish(Topic.ORDER_REJECTED, { ...intent, quantity: result.unfilledQuantity, reason: `${intent.reason}｜盘口深度不足，剩余撤销` });
    }
    return fill;
  }

  /**
   * 一次性全部成交。
   *
   * 现金账户语义：BUY 成交前查一次可用现金。付得起就按原量成交；付不起就
   * **按现金能买到的量成交**（买单本来就等价于「把这笔钱投进去」），
   * 只有当现金连最小的量都买不起时才拒单（广播 ORDER_REJECTED）。
   * 绝不透支 —— 真实券商不会让你花没有的钱。
   *
   * 为什么不直接拒单：订单在上一根收盘按当时的价格定量，成交在下一根开盘，
   * 期间价格会动。按「价位差一点就整单拒掉」的口径，粗周期（每根波动大）
   * 上的满仓买单会反复被拒、策略又反复重试，事件流里刷满「拒单」——
   * 那是模拟口径自己造出来的噪声，不是市场行为。
   *
   * executedAt = 真正成交的那根 K 线时间。必须用它而不是决策时间：
   * 决策发生在第 t 根收盘，成交发生在第 t+1 根开盘，两者是不同的时刻，
   * 流水里写错时间会让人按错误的价格去核对甚至照着追单。
   */
  private fillWholeOrder(intent: OrderIntent, mid: number, executedAt?: Date): Fill | null {
    const stats = this.micro?.(intent.symbol);
    const bps = this.cost.slippageBps(intent.quantity * mid, stats);
    const execPrice = this.cost.execPrice(mid, intent.side, bps);
    const affordable = this.affordableQuantity(intent, execPrice);
    if (affordable === null) return null;
    const order = affordable < intent.quantity ? { ...intent, quantity: affordable } : intent;
    const notional = order.quantity * execPrice;
    const fee = notional * this.opts.feeRate;
    const fill: Fill = {
      order,
      price: execPrice,
      fee,
      timestamp: executedAt ?? intent.timestamp,
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

  /**
   * 现金约束下这笔买单最多能成交多少。
   * - 卖单 / 未接现金查询：返回原量（不受约束）；
   * - 付得起全额：返回原量；
   * - 只付得起一部分：返回付得起的量（按可用现金折算，含手续费）；
   * - 连零头都买不起：拒单（返回 null，广播 ORDER_REJECTED）。
   */
  private affordableQuantity(intent: OrderIntent, execPrice: number): number | null {
    if (intent.side !== "BUY" || !this.opts.availableCash) return intent.quantity;
    const cash = this.opts.availableCash();
    const required = intent.quantity * execPrice * (1 + this.opts.feeRate);
    if (required <= cash + 1e-9) return intent.quantity;
    // 可用现金 ÷ 单价（含费），再留一点点余量抵消浮点误差，保证成交后现金不为负
    const affordable = (cash / (execPrice * (1 + this.opts.feeRate))) * (1 - 1e-12);
    if (!(affordable >= 1e-9)) {
      log.info(
        "现金不足，买单被驳回: %s 需要 %s，可用 %s",
        intent.symbol,
        required.toFixed(2),
        cash.toFixed(2),
      );
      this.bus.publish(Topic.ORDER_REJECTED, {
        ...intent,
        reason: `现金不足：需要 ${required.toFixed(2)}，可用 ${cash.toFixed(2)}（现金账户不透支）`,
      });
      return null;
    }
    log.info(
      "现金不足，按可用现金成交: %s 由 %s 减为 %s（可用现金 %s）",
      intent.symbol,
      intent.quantity.toFixed(6),
      affordable.toFixed(6),
      cash.toFixed(2),
    );
    return affordable;
  }

  /** K 线推进：维护量能/行情窗口、执行到期切片。 */
  private onBar(bar: Bar): void {
    this.recordVolume(bar);
    this.recordWindow(bar);
    this.barIndex += 1;
    this.executeQueued(bar);
    if (!this.slicingOn || this.pending.size === 0) return;
    for (const order of [...this.pending.values()]) {
      const due = takeDueSlice(order, this.barIndex);
      if (!due) continue;
      this.executeDueSlice(order, undefined, due, bar);
      if (isDone(order)) {
        this.pending.delete(order.id);
        this.pushCompleted(report(order, false));
      }
    }
  }

  /** 执行当前到期的那一片，并广播子单成交。 */
  /**
   * 成交一片。成交价取**这根 K 线的开盘价**（由 onBar 传入），
   * 与不拆单时同一口径；没有开盘价时退回当根收盘价并如实记原因。
   */
  private executeDueSlice(
    order: SlicedOrder,
    intent?: OrderIntent,
    due?: { quantity: number; barOffset: number },
    bar?: Bar,
  ): Fill | null {
    const slice = due ?? takeDueSlice(order, this.barIndex);
    if (!slice) return null;
    const open = bar?.open;
    const mid = Number.isFinite(open) && (open as number) > 0 ? (open as number) : this.book.last(order.symbol);
    if (mid === undefined || !(slice.quantity > 0)) {
      log.warn("拆单切片无行情，暂缓: %s", order.symbol);
      return null;
    }

    const stats = this.micro?.(order.symbol);
    // 每片按自己的金额单独算冲击：拆单省成本的来源就在这一行
    const bps = this.cost.slippageBps(slice.quantity * mid, stats);
    const execPrice = this.cost.execPrice(mid, order.side, bps);

    const sliceOrder: OrderIntent = {
      symbol: order.symbol,
      side: order.side,
      quantity: slice.quantity,
      price: mid,
      timestamp: bar?.timestamp ?? intent?.timestamp ?? new Date(),
      reason: intent ? intent.reason : `slice_${order.next - 1 + 1}/${order.plan.length}`,
    };

    // 现金账户语义同样适用于逐片成交：这一片买得起多少成交多少（含费）；
    // 连零头都买不起就终止整单 —— 现金都没了，后面的片只会更买不起。
    const affordable = this.affordableQuantity(sliceOrder, execPrice);
    if (affordable === null) {
      this.pending.delete(order.id);
      this.pushCompleted(report(order, false));
      return null;
    }
    const filled = Math.min(slice.quantity, affordable);
    const notional = filled * execPrice;
    const fee = notional * this.opts.feeRate;
    recordSliceFill(order, { quantity: filled, price: execPrice, fee });

    const fill: Fill = {
      order: filled === sliceOrder.quantity ? sliceOrder : { ...sliceOrder, quantity: filled },
      price: execPrice,
      fee,
      timestamp: sliceOrder.timestamp,
    };

    log.debug(
      "PAPER 切片 %s %s %s @ %s（累计 %s / %s）",
      order.side,
      order.symbol,
      filled.toFixed(6),
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