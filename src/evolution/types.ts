/**
 * 自我进化：让系统从自己的决策结果里学习，而不是让模型自己乱改。
 *
 * 三件事，各自有明确边界：
 * 1) 记录：每次决策（各标的权重 + 理由）都留痕；
 * 2) 结算：horizon 根 K 线后回填实际结果（含相对空仓/等权基准的超额）；
 * 3) 调参：样本足够时按统计结果微调**搜索类参数**，并写明理由与前后值。
 *
 * 刻意的限制（安全优先）：
 * - 总开关默认关闭：自动改交易参数是需要显式授权的事；
 * - 只调白名单里的搜索参数，回撤熔断/单笔上限等风控参数永不自动放宽；
 * - 单次变动有幅度上限、变更之间有冷却、样本不足不动手；
 * - 每次变更都进变更日志，可一键回滚上一次。
 */

import type { AppConfig } from "../configSchema.js";

/** 一次决策的结果（结算前）。 */
export interface DecisionRecord {
  id: number;
  at: string;
  /** 归属：机器人 id；全局运行为 "engine" */
  owner: string;
  /** 决策来源：rules / chat / systemone / hybrid */
  source: string;
  weights: Record<string, number>;
  cashWeight: number;
  confidence: number;
  reason: string;
  /** 记录时各标的的参考价，用于算收益 */
  refPrices: Record<string, number>;
  /** 记录时已推进的 K 线根数（用于判断 horizon 是否到期） */
  entryBarIndex?: number;
  outcome?: DecisionOutcome;
}

/** 结算结果。 */
export interface DecisionOutcome {
  horizonBars: number;
  /** 组合在这段窗口的实际收益 */
  returnPct: number;
  /** 相对「空仓」的超额（即真的靠选股赚到了） */
  alpha: number;
  /** 窗口内最大不利偏移 */
  maxAdverse: number;
  settledAt: string;
}

export interface EvolutionStats {
  total: number;
  settled: number;
  pending: number;
  winRate: number;
  avgReturn: number;
  avgAlpha: number;
  /** 相对空仓基准的胜率 */
  beatRate: number;
  /** 表现最好的标的 */
  bestSymbol: string | null;
  bestSymbolAlpha: number;
  /** 最近一次评估时间 */
  lastEvaluatedAt: string | null;
  /** 当前处于冷却期到什么时候 */
  cooldownUntil: string | null;
  /** 距离下次可评估还剩多少样本 */
  samplesNeeded: number;
}

export interface ChangeLogEntry {
  at: string;
  param: string;
  before: unknown;
  after: unknown;
  reason: string;
  /** 依据的统计快照，便于事后核对 */
  evidence: { settled: number; avgAlpha: number; beatRate: number };
  /** 是否已回滚 */
  reverted: boolean;
}

export interface EvolutionView {
  enabled: boolean;
  stats: EvolutionStats;
  changelog: ChangeLogEntry[];
  recentDecisions: (DecisionRecord & { symbols: string[] })[];
  limits: {
    minSamples: number;
    cooldownMs: number;
    maxChangeRatio: number;
    horizonBars: number;
    tunable: string[];
  };
}

/** 允许自动调整的参数（白名单 + 取值范围 + 整数约束）。 */
export const PARAM_RULES: Record<
  string,
  {
    read: (c: AppConfig) => number;
    write: (c: AppConfig, v: number) => void;
    min: number;
    max: number;
    integer: boolean;
    /** 当前值为 0 时的起步幅度（比例法对 0 无效） */
    minStep: number;
    label: string;
  }
> = {
  "strategy.fastWindow": {
    read: (c) => c.strategy.fastWindow,
    write: (c, v) => {
      c.strategy.fastWindow = v;
    },
    min: 2,
    max: 60,
    integer: true,
    minStep: 1,
    label: "快线窗口",
  },
  "strategy.slowWindow": {
    read: (c) => c.strategy.slowWindow,
    write: (c, v) => {
      c.strategy.slowWindow = v;
    },
    min: 5,
    max: 400,
    integer: true,
    minStep: 2,
    label: "慢线窗口",
  },
  "strategy.maxTargetWeight": {
    read: (c) => c.strategy.maxTargetWeight,
    write: (c, v) => {
      c.strategy.maxTargetWeight = v;
    },
    min: 0.05,
    max: 0.95,
    integer: false,
    minStep: 0.02,
    label: "目标仓上限",
  },
  "risk.minTradeValue": {
    read: (c) => c.risk.minTradeValue,
    write: (c, v) => {
      c.risk.minTradeValue = v;
    },
    min: 0,
    max: 200_000,
    integer: false,
    minStep: 500,
    label: "最小调仓额",
  },
};

export const TUNABLE_PARAMS = Object.keys(PARAM_RULES);

export function paramLabel(key: string): string {
  return PARAM_RULES[key]?.label ?? key;
}

/**
 * 根据结算统计算出要调什么。
 *
 * 规则（刻意保守）：
 * - 长期跑输空仓基准 -> 收缩风险：降目标仓上限、抬高最小调仓额（少动）；
 * - 跑赢且样本足-> 小步放开目标仓上限（但不超过风控的单标的上限）；
 * - 波动大（最大不利偏移大）-> 抬高最小调仓额；
 * - 表现差的标的占比高 -> 快线/慢线太敏感或太迟钝，按方向微调。
 * 返回空数组表示不动手。
 */
export function proposeTuning(
  stats: EvolutionStats,
  config: AppConfig,
  limits: { tunable: string[]; maxChangeRatio: number },
): { param: string; value: number; reason: string }[] {
  const out: { param: string; value: number; reason: string }[] = [];
  const settled = stats.settled;
  if (settled < 1) return out;

  const alpha = stats.avgAlpha;
  const allowed = (key: string): boolean => limits.tunable.includes(key);

  // 1) 跑输 -> 收缩目标仓上限
  if (allowed("strategy.maxTargetWeight") && alpha < -0.002) {
    const cur = PARAM_RULES["strategy.maxTargetWeight"]!.read(config);
    const next = step(cur, -limits.maxChangeRatio, PARAM_RULES["strategy.maxTargetWeight"]!);
    if (next < cur) {
      out.push({
        param: "strategy.maxTargetWeight",
        value: next,
        reason: `近 ${settled} 笔结算平均超额 ${(alpha * 100).toFixed(2)}%，跑输空仓基准，收缩目标仓上限 ${pct(cur)} → ${pct(next)}`,
      });
    }
  }

  // 2) 跑赢 -> 小步放开（但不许超过风控的单标的上限）
  if (allowed("strategy.maxTargetWeight") && alpha > 0.004 && stats.beatRate > 0.55) {
    const cur = PARAM_RULES["strategy.maxTargetWeight"]!.read(config);
    const ceiling = Math.min(PARAM_RULES["strategy.maxTargetWeight"]!.max, config.risk.maxPositionWeight);
    const next = Math.min(step(cur, limits.maxChangeRatio, PARAM_RULES["strategy.maxTargetWeight"]!), ceiling);
    if (next > cur) {
      out.push({
        param: "strategy.maxTargetWeight",
        value: next,
        reason: `近 ${settled} 笔平均超额 +${(alpha * 100).toFixed(2)}%，胜率 ${(stats.beatRate * 100).toFixed(0)}%，小步放开目标仓上限 ${pct(cur)} → ${pct(next)}`,
      });
    }
  }

  // 3) 换手/摩擦成本偏高（平均不利偏移大）-> 抬高最小调仓额
  if (allowed("risk.minTradeValue") && stats.avgAlpha <= 0 && stats.beatRate < 0.5) {
    const cur = PARAM_RULES["risk.minTradeValue"]!.read(config);
    const next = step(cur, limits.maxChangeRatio, PARAM_RULES["risk.minTradeValue"]!);
    if (next > cur) {
      out.push({
        param: "risk.minTradeValue",
        value: next,
        reason: `胜率仅 ${(stats.beatRate * 100).toFixed(0)}%、平均超额 ${(alpha * 100).toFixed(2)}%，减少噪声调仓：最小调仓额 ${Math.round(cur)} → ${Math.round(next)}`,
      });
    }
  }

  // 4) 均线参数：样本够多且长期负超额时，换一档更钝的窗口（避免追涨杀跌）
  if (allowed("strategy.fastWindow") && settled >= 20 && alpha < -0.004) {
    const cur = PARAM_RULES["strategy.fastWindow"]!.read(config);
    const next = step(cur, -limits.maxChangeRatio, PARAM_RULES["strategy.fastWindow"]!);
    if (next >= PARAM_RULES["strategy.fastWindow"]!.min && next < config.strategy.slowWindow) {
      out.push({
        param: "strategy.fastWindow",
        value: next,
        reason: `样本 ${settled} 笔、平均超额 ${(alpha * 100).toFixed(2)}%，快线过敏感，降快线窗口 ${Math.round(cur)} → ${Math.round(next)}`,
      });
    }
  }

  return out;
}

/**
 * 按最大变动比例走一步，并夹在允许范围内。
 * 当前值为 0 时比例法算不出变化（例如最小调仓额从 0 起），
 * 这种情况改用规则里的最小步长，避免「永远调不动」。
 */
function step(current: number, ratio: number, rule: { min: number; max: number; integer: boolean; minStep: number }): number {
  const delta = current > 0 ? current * ratio : rule.minStep;
  let next = current + delta;
  if (rule.integer) next = Math.round(next);
  return Math.min(rule.max, Math.max(rule.min, Number(next.toFixed(4))));
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}