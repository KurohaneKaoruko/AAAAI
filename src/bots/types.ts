/** 交易机器人：可并行运行多个，每个独立配置模型、策略与标的。 */

import type { DecisionSource } from "../configSchema.js";

export type BotMode = "backtest" | "live";
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
}

export interface BotView extends BotConfig {
  state: BotState;
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