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

export interface BotState {
  id: string;
  status: BotStatus;
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
}

export interface BotView extends BotConfig {
  state: BotState;
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
  strategy?: Partial<BotStrategy>;
  risk?: Partial<BotRisk>;
  enabled?: boolean;
}