/** 交易机器人：可并行运行多个，每个独立配置模型、策略与标的。 */

import type { DecisionSource } from "../configSchema.js";

/**
 * 机器人的运行方式。
 * 只有实时一种：机器人是实时实体 —— 决策来自实时行情，统计来自实时操作。
 * 历史数据模拟（回放验证）不属于机器人，在独立的「回测」页做。
 */
export type BotMode = "live";
export type BotStatus = "idle" | "running" | "stopped" | "error";

/**
 * 机器人引用的策略 id（指向策略列表里的一条）。
 * 老数据没有这个字段时由 botManager 迁移生成。
 */
export type BotStrategyId = string;

/** 机器人的策略参数（已废弃：改由策略列表按 id 引用，此处仅为兼容旧数据保留）。 */
export interface BotStrategy {
  fastWindow: number;
  slowWindow: number;
  maxTargetWeight: number;
  /** 由 AI 在候选池里自行选资产并配权重 */
  selfAllocating: boolean;
  /** 最多同时持有几个资产 */
  maxPositions: number;
  /** 组合总仓位上限 */
  maxGrossExposure: number;
  /** 每 N 轮行情配置一次 */
  allocationInterval: number;
  /** 混合决策：分析结论对决策模型的影响力（0~1） */
  hybridInfluence: number;
}

/** 机器人的风控参数（覆盖全局 risk）。 */
export interface BotRisk {
  initialCash: number;
  maxPositionWeight: number;
  maxOrderValue: number;
  maxDrawdownPct: number;
  /** 最小调仓金额：低于此值不下单 */
  minTradeValue: number;
}

/** 机器人配置（不含运行期状态）。 */
export interface BotConfig {
  id: string;
  name: string;
  enabled: boolean;
  /** 行情/交易连接 */
  connectionId: string;
  symbols: string[];
  mode: BotMode;
  interval: string;
  /** 预热/回测 K 线数 */
  barCount: number;
  /** 轮询间隔（毫秒，实时模式） */
  pollMs: number;
  /** 决策来源：rules | chat | systemone | hybrid（与策略列表里的那条保持一致） */
  decisionSource: DecisionSource;
  /** 引用的策略 id；新机器人必填，旧机器人在加载时自动迁移 */
  strategyId?: string;
  /** 本机器人专用的模型实例 ID 列表（留空 = 用该类型的全部实例） */
  modelProfileIds: string[];
  /** 每 N 根 K 线问一次模型 */
  decisionInterval: number;
  /**
   * 实时模式下的成交方式：
   * - true ：真实下单（需满足实盘四条件，同一连接限一个）
   * - false：模拟成交 —— 行情是真的，撮合在本地，零资金风险
   * 这是机器人自己的开关，与「风控」页的全局执行方式相互独立：
   * 全局说"可以真实下单"，具体哪个机器人真下单仍由它自己决定。
   */
  paperTrading: boolean;
  strategy: BotStrategy;
  risk: BotRisk;
  createdAt: string;
}

/** 单个标的在该账号中的配置情况。 */
export interface BotHolding {
  symbol: string;
  quantity: number;
  avgCost: number;
  price: number;
  /** 市值 */
  marketValue: number;
  /** 占总权益比例（0~1） */
  weight: number;
  /** 浮动盈亏 */
  unrealizedPnl: number;
}

/** 某个账号此刻的资产配置快照。 */
export interface BotAllocation {
  timestamp: string;
  equity: number;
  cash: number;
  /** 现金比例 */
  cashWeight: number;
  holdings: BotHolding[];
  /** 持仓数 / 候选数 */
  heldCount: number;
  /**
   * 最新目标权重（symbol -> 0~1，未出现 = 0）。
   * 来自最新一次决策（AI 配置或信号的目标权重）—— 有了它才能算出
   * "还要买卖多少才到位"，也就是人工模仿需要的操作指引。
   */
  targets: Record<string, number>;
  /** 最新决策时间（无决策时为 null） */
  decidedAt: string | null;
  /** 决策理由（最新一次） */
  reason: string;
  /** 各标的的最新价（来自行情；未出现价的标的无法给出指引） */
  prices: Record<string, number>;
}

export interface BotMetrics {
  finalEquity: number;
  cash: number;
  openPositions: number;
  totalFills: number;
  maxDrawdownPct: number;
  realizedPnl: number;
  equityPoints: number;
  /** 收益率 */
  totalReturn: number;
}

/** 成交流水的一行（机器人维度的交易统计明细）。 */
export interface BotTrade {
  id: number;
  timestamp: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  fee: number;
  /** 卖出/减仓时结算的已实现盈亏；买入为 0 */
  realizedPnl: number;
  /** 触发该成交的决策理由（含 [llm] / systemone / fallback 标记） */
  reason: string;
}

export interface BotState {
  id: string;
  status: BotStatus;
  /**
   * 本次运行是否真的在发真实订单。
   * 三种取值要分清：
   * - live  ：订单真实发往交易所
   * - paper ：用真实行情、本地模拟撮合（默认，安全）
   * - backtest：跑一次历史，跑完即停
   * 界面必须原样透出：用户得随时知道钱有没有真的动。
   */
  liveTrading: boolean;
  /**
   * 权益曲线（仅保留尾部若干点）。
   * 仪表盘要看的是"各个机器人跑得怎么样"，所以曲线必须来自机器人本身，
   * 而不是另一次单账户引擎运行的结果。
   */
  equityCurve: { timestamp: string; equity: number }[];
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  metrics: BotMetrics | null;
  /** 当前资产配置（各标的权重 + 现金），随运行实时更新 */
  allocation: BotAllocation | null;
  bars: number;
  /**
   * 预载入的历史 K 线数（仅用于喂指标，不产生任何成交）。
   * 界面上要和 bars 分开说："预热 N 根 · 实时 M 根"，否则用户会问
   * "为什么启动就处理了 120 根却一单没成"。
   */
  warmupBars: number;
  durationMs: number;
  /** 最近事件（该机器人自己的） */
  events: { topic: string; timestamp: string; summary: string }[];
  /** 成交流水（新->旧，尾部若干条）。交易统计的明细就在这里，不再依赖"另开一页查" */
  trades: BotTrade[];
  /**
   * 各标的的已实现盈亏合计（按 symbol 聚合）。
   * "哪个标的在赚钱/亏钱"是交易统计里最常被问的问题，直接算好。
   */
  pnlBySymbol: { symbol: string; realizedPnl: number; fills: number }[];
  /**
   * 当前仓位调整指引（供人工对照实盘模仿）。
   *
   * 模拟盘与实盘的唯一差别就是不下单：决策、信号、目标仓位全部一致。
   * 于是"下一步该做什么"完全可以算出来交给人 —— 不敢全权交给机器人时，
   * 照着这份清单在自己的交易所 APP 里手动下单即可。
   */
  actions: BotAction[];
}

/** 一条仓位调整指引：把机器人的目标仓位换算成"人可以照做"的操作。 */
export interface BotAction {
  symbol: string;
  /** BUY = 加仓/建仓，SELL = 减仓/清仓，HOLD = 无需操作 */
  side: "BUY" | "SELL" | "HOLD";
  /** 建议数量（按参考价换算） */
  quantity: number;
  /** 参考价（行情最新价） */
  price: number;
  /** 涉及金额（quantity * price） */
  value: number;
  /** 当前权重 -> 目标权重 */
  fromWeight: number;
  toWeight: number;
  /** 当前持仓数量 */
  holdingQty: number;
  /** 目标对应的持仓数量（可达时） */
  targetQty: number;
  /** 决策理由（来自信号/配置） */
  reason: string;
  /** 该指引依据的决策时间 */
  at: string;
  /** 为什么没给操作（如差额小于最小调仓额、价格缺失等） */
  note?: string;
}

/**
 * 一次运行（start -> stop）的存档记录。
 *
 * 为什么要有它：机器人的运行状态只活在内存里，重启即失，而且每次启动都从初始资金
 * 重新跑 —— 只看当前状态，用户无法回答"这个机器人长期是赚是赔、哪几次跑得好"。
 * 这个结构就是为了回答那个问题，所以它的每一项都必须是真的（截断的明细必须标注截断）。
 */
export interface BotRunRecord {
  id: string;
  botId: string;
  /** 运行时的机器人名字（改名后历史里仍保留当时的名字） */
  name: string;
  mode: BotMode;
  /** 这次运行是模拟成交（true）还是真实下单（false） */
  paperTrading: boolean;
  /** 这次运行是否真的把订单发给了交易所 */
  liveTrading: boolean;
  status: "running" | "stopped" | "error";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  bars: number;
  /** 当时跑的标的（历史里保留，避免改名/换标的后对不上账） */
  symbols: string[];
  /** 当时引用的策略名 */
  strategyName: string;
  metrics: BotMetrics | null;
  equityCurve: { timestamp: string; equity: number }[];
  /** 成交流水尾部若干条（可能被截断，见 tradesTruncated） */
  trades: BotTrade[];
  /** trades 是否只是尾部若干笔而非全部 —— 界面必须据此说明，不能让人误读 */
  tradesTruncated: boolean;
  pnlBySymbol: { symbol: string; realizedPnl: number; fills: number }[];
  error: string | null;
}

/** 跨多次运行的汇总（口径写在界面上：各次已实现盈亏求和，不是复利）。 */
export interface BotHistoryTotals {
  runs: number;
  /** 收益率为正的运行次数 */
  wins: number;
  /** 收益率为负的运行次数 */
  losses: number;
  /** 各次运行已实现盈亏之和（绝对金额口径） */
  cumulativeRealizedPnl: number;
  /** 各次运行成交笔数之和 */
  totalFills: number;
  /** 最好单次收益率 */
  bestReturn: number;
  /** 最差单次收益率 */
  worstReturn: number;
  /** 最近一次运行的时间（优先 finishedAt） */
  lastRunAt: string | null;
}

export interface BotView extends BotConfig {
  state: BotState;
  /** 历史运行存档（新 -> 旧，跨重启保留） */
  history: BotRunRecord[];
  /** 历史汇总（由 history 实时算出，不落盘） */
  totals: BotHistoryTotals;
  /**
   * 拆单执行统计（仅 paper 券商且开了拆单时有值）。
   * 单账户引擎删除后，这里是拆单执行结果的唯一来源。
   */
  slicing?: {
    algo: "none" | "twap" | "vwap";
    slices: number;
    /** 已完成的拆单笔数 */
    completed: number;
    /** 尚未到期的切片笔数 */
    pending: number;
    /** 平均实施短缺（bps，正 = 多付，负 = 省下） */
    avgShortfallBps: number;
  };
  /** 生效的模型实例名称，便于一眼确认"这个机器人在用谁" */
  modelLabels: string[];
}

/** 新建机器人的输入。 */
export interface BotInput {
  name: string;
  connectionId: string;
  symbols: string[];
  mode?: BotMode;
  interval?: string;
  barCount?: number;
  pollMs?: number;
  decisionSource?: DecisionSource;
  /** 引用的策略 id（策略列表里的一条）。新建时若不提供，会按现有参数新建一条策略 */
  strategyId?: string;
  modelProfileIds?: string[];
  decisionInterval?: number;
  /** 实时模式的成交方式：true = 真实下单（需满足实盘条件），false = 模拟成交（默认） */
  paperTrading?: boolean;
  strategy?: Partial<BotStrategy>;
  risk?: Partial<BotRisk>;
  enabled?: boolean;
}