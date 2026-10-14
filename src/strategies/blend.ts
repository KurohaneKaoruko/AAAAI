/**
 * 混合决策：把多路决策按配比融合成一份最终权重。
 *
 * 「多路」可以是：纯规则动量、对话模型池、System One 决策模型池。
 * 融合是线性加权——各路给出自己的权重表，按配比加权求和；
 * 不可用或配比为 0 的路会被剔除，配比在其余可用路之间按比例重新分配，
 * 因此「配比 3:2，其中一路挂了」不会让总仓位凭空缩水。
 *
 * 融合后仍要走一遍额度裁剪（单标的上限 / 总仓位上限 / 持仓数上限），
 * 所以无论哪一路给出离谱的权重，最终下到组合里的都是合法配置。
 */

import { getLogger } from "../core/logger.js";
import type { DecisionSource } from "../configSchema.js";
import type { Signal } from "../core/types.js";
import { normalizeAllocation, type AllocationLimits, type AssetSnapshot } from "../llm/allocation.js";
import type { AllocationResult, AllocationSource } from "./allocator.js";
import type { Strategy, StrategyContext } from "./strategy.js";

const log = getLogger("blend");

/** 一路决策。 */
export interface Lane {
  source: DecisionSource;
  /** 配比（>=0），0 表示不参与 */
  weight: number;
  /** 是否可用（例如该类模型没配实例） */
  available: boolean;
}

export interface BlendRatios {
  /** source -> 归一化后的配比（和为 1） */
  ratios: Record<DecisionSource, number>;
  /** 被剔除的路（配比 0 或不可用） */
  dropped: DecisionSource[];
}

/**
 * 归一化配比：剔除不可用/权重为 0 的路后按比例重分配。
 * 若一条可用路都不剩，则退回纯规则（保证任何情况下都有决策）。
 */
export function blendRatios(lanes: Lane[]): BlendRatios {
  const usable = lanes.filter((l) => l.available && l.weight > 0);
  const dropped = lanes.filter((l) => !usable.includes(l)).map((l) => l.source);
  const pool = usable.length > 0 ? usable : lanes.filter((l) => l.source === "rules");

  const total = pool.reduce((acc, l) => acc + Math.max(0, l.weight), 0);
  const ratios = { rules: 0, chat: 0, systemone: 0 } as Record<DecisionSource, number>;
  if (total <= 0) {
    // 配比全为 0：等权
    for (const l of pool) ratios[l.source] += 1 / Math.max(1, pool.length);
  } else {
    for (const l of pool) ratios[l.source] += Math.max(0, l.weight) / total;
  }
  if (pool.some((l) => l.source === "rules") === false && Object.values(ratios).every((v) => v === 0)) {
    ratios.rules = 1;
  }
  return { ratios, dropped: [...new Set(dropped)] };
}

/**
 * 加权融合多路权重表。
 * conflict：各路首选标的不一致时给出提示（分歧越大越值得警惕）。
 */
export function blendWeightMaps(
  lanes: Lane[],
  maps: Record<DecisionSource, Record<string, number>>,
): {
  weights: Record<string, number>;
  ratios: Record<DecisionSource, number>;
  dropped: DecisionSource[];
  conflict: string | null;
} {
  const { ratios, dropped } = blendRatios(lanes);
  const symbols = new Set<string>();
  for (const map of Object.values(maps)) {
    for (const s of Object.keys(map)) symbols.add(s);
  }

  const weights: Record<string, number> = {};
  for (const symbol of symbols) {
    let sum = 0;
    for (const source of Object.keys(ratios) as DecisionSource[]) {
      const ratio = ratios[source];
      if (ratio <= 0) continue;
      sum += ratio * (maps[source]?.[symbol] ?? 0);
    }
    if (sum > 0) weights[symbol] = Number(sum.toFixed(6));
  }

  return { weights, ratios, dropped, conflict: topPickConflict(maps, ratios) };
}

/** 各路第一名是否一致；不一致时描述分歧。 */
function topPickConflict(
  maps: Record<DecisionSource, Record<string, number>>,
  ratios: Record<DecisionSource, number>,
): string | null {
  const picks: { source: DecisionSource; symbol: string; weight: number }[] = [];
  for (const source of Object.keys(ratios) as DecisionSource[]) {
    if (ratios[source] <= 0) continue;
    const entries = Object.entries(maps[source] ?? {});
    if (entries.length === 0) continue;
    entries.sort((a, b) => b[1] - a[1]);
    const [symbol, weight] = entries[0]!;
    picks.push({ source, symbol, weight });
  }
  if (picks.length < 2) return null;
  const distinct = new Set(picks.map((p) => p.symbol));
  if (distinct.size === 1) return null;
  return `各路首选不一致：${picks.map((p) => `${SOURCE_ZH[p.source]}→${p.symbol}`).join("，")}`;
}

export const SOURCE_ZH: Record<DecisionSource, string> = {
  rules: "规则",
  chat: "对话模型",
  systemone: "决策模型",
};

/** 逐标的模式：多路信号按配比融合成一个目标仓位。 */
export class BlendedStrategy implements Strategy {
  readonly name = "blended";
  readonly warmup: number;

  constructor(private readonly lanes: Lane[], private readonly strategies: Partial<Record<DecisionSource, Strategy>>) {
    this.warmup = Math.max(1, ...Object.values(strategies).map((s) => s?.warmup ?? 0));
  }

  async generate(ctx: StrategyContext): Promise<Signal | null> {
    const active = this.lanes.filter((l) => this.strategies[l.source] && (l.available && l.weight > 0));
    const answers = await Promise.all(
      active.map(async (lane) => {
        try {
          return { lane, signal: await this.strategies[lane.source]!.generate(ctx) };
        } catch (err) {
          log.warn("%s 决策失败，按 0 权重处理: %s", lane.source, (err as Error).message);
          return { lane, signal: null };
        }
      }),
    );

    const answered = answers.filter((a) => a.signal !== null) as { lane: Lane; signal: Signal }[];
    if (answered.length === 0) return null;

    const { ratios, dropped } = blendRatios(active);
    let targetWeight = 0;
    let confidence = 0;
    const reasons: string[] = [];
    for (const { lane, signal } of answered) {
      const ratio = ratios[lane.source];
      targetWeight += ratio * signal.targetWeight;
      confidence += ratio * signal.confidence;
      if (ratio > 0 && signal.reason) reasons.push(`${SOURCE_ZH[lane.source]}: ${clip(signal.reason, 40)}`);
    }
    const weight = Math.min(Math.max(targetWeight, 0), 1);
    if (weight <= 0) return null;

    const dropNote = dropped.length > 0 ? ` [${dropped.map((d) => SOURCE_ZH[d]).join("+")}未参与]` : "";
    return {
      symbol: ctx.symbol,
      timestamp: answered[0]!.signal.timestamp,
      targetWeight: Number(weight.toFixed(6)),
      confidence: Number(confidence.toFixed(4)),
      reason: `[mix ${mixLabel(ratios)}]${reasons.join(" | ")}${dropNote}`,
    };
  }
}

/** 资产配置模式：多路配置按配比融合后再走额度裁剪。 */
export class BlendedAllocator {
  constructor(
    private readonly lanes: Lane[],
    private readonly allocators: Partial<Record<DecisionSource, { allocate: (s: AssetSnapshot[]) => Promise<AllocationResult> }>>,
    private readonly limits: AllocationLimits,
  ) {}

  async allocate(snapshots: AssetSnapshot[]): Promise<AllocationResult> {
    const active = this.lanes.filter((l) => this.allocators[l.source] && l.available && l.weight > 0);
    const pool = active.length > 0 ? active : this.lanes.filter((l) => this.allocators[l.source]);
    if (pool.length === 0) {
      return { weights: {}, cashWeight: 1, confidence: 0, reason: "无可用决策路", source: "rules", notes: [] };
    }

    const results = await Promise.all(
      pool.map(async (lane) => {
        try {
          const r = await this.allocators[lane.source]!.allocate(snapshots);
          return { lane, result: r };
        } catch (err) {
          log.warn("%s 配置失败，按 0 权重处理: %s", lane.source, (err as Error).message);
          return { lane, result: null };
        }
      }),
    );

    const maps: Record<DecisionSource, Record<string, number>> = { rules: {}, chat: {}, systemone: {} };
    for (const { lane, result } of results) {
      if (result) maps[lane.source] = result.weights;
    }
    // 传全部路而非过滤后的：这样「哪一路没参与」才能被记录下来告知用户
    const blended = blendWeightMaps(this.lanes, maps);

    const normalized = normalizeAllocation(
      {
        weights: blended.weights,
        cashWeight: 0,
        confidence: 0,
        reason: "",
      },
      snapshots.map((s) => s.symbol),
      this.limits,
    );

    let confidence = 0;
    const reasons: string[] = [];
    const aiUsed = new Set<DecisionSource>();
    for (const { lane, result } of results) {
      if (!result) continue;
      const ratio = blended.ratios[lane.source];
      if (ratio <= 0) continue;
      confidence += ratio * result.confidence;
      if (result.reason) reasons.push(`${SOURCE_ZH[lane.source]}: ${clip(result.reason, 36)}`);
      if (result.source === "ai") aiUsed.add(lane.source);
      for (const note of result.notes) {
        if (ratio > 0.2) normalized.notes.push(`${SOURCE_ZH[lane.source]}: ${note}`);
      }
    }
    if (blended.conflict) normalized.notes.push(blended.conflict);
    if (blended.dropped.length > 0) {
      normalized.notes.push(`${blended.dropped.map((d) => SOURCE_ZH[d]).join("、")} 未参与（无可用实例或配比为 0）`);
    }

    // 只剩一路时如实报它的来源，别把单路说成「混合」
    const contributing = (Object.keys(blended.ratios) as DecisionSource[]).filter((s) => blended.ratios[s] > 0);
    const onlyOne = contributing.length === 1;
    const singleSource = results.find((r) => r.result && blended.ratios[r.lane.source] > 0)?.result?.source;
    const source: AllocationSource = onlyOne
      ? ((singleSource ?? "rules") as AllocationSource)
      : aiUsed.size > 0
        ? "mix"
        : "rules";
    return {
      weights: normalized.weights,
      cashWeight: normalized.cashWeight,
      confidence: Number(confidence.toFixed(4)),
      reason: reasons.slice(0, 3).join(" | ") || "多路融合",
      source,
      notes: normalized.notes,
    };
  }
}

function mixLabel(ratios: Record<DecisionSource, number>): string {
  const parts = (Object.keys(ratios) as DecisionSource[])
    .filter((s) => ratios[s] > 0)
    .map((s) => `${SOURCE_ZH[s]}${Math.round(ratios[s] * 100)}%`);
  return parts.join("/");
}

function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}