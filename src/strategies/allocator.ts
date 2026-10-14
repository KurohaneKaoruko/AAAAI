/**
 * 资产配置器：决定「这一轮买哪些、各占多少、留多少现金」。
 *
 * 两层：
 * - CrossSectionalAllocator：横截面动量基线，纯规则、确定性，负责兜底与对照；
 * - AIAllocator：把候选资产的技术面摘要交给模型，由模型选标的配权重；
 *   模型不可用/超时/输出非法时自动回退基线，绝不让组合停在无策略状态。
 */

import { getLogger } from "../core/logger.js";
import {
  buildAllocationPrompt,
  normalizeAllocation,
  parseAllocation,
  type AllocationLimits,
  type AssetSnapshot,
} from "../llm/allocation.js";
import type { LLMClient } from "../llm/llmClient.js";
import type { DecisionSource } from "../configSchema.js";
import type { JointBoard } from "../llm/jointBoard.js";

const log = getLogger("allocator");

export type AllocationSource = "rules" | "ai" | "mix" | "fallback";

export interface AllocationResult {
  /** symbol -> 目标权重（占总权益） */
  weights: Record<string, number>;
  /** 现金比例 = 1 - Σ权重 */
  cashWeight: number;
  confidence: number;
  reason: string;
  source: AllocationSource;
  /** 裁剪/回退的说明，便于在事件流里看清 AI 说了什么、被改了什么 */
  notes: string[];
}

/** 横截面动量基线：按动量排序取前 N 名，按正动量比例分配权重。 */
export class CrossSectionalAllocator {
  async allocate(
    snapshots: AssetSnapshot[],
    limits: AllocationLimits,
  ): Promise<AllocationResult> {
    const scored = snapshots
      .filter((s) => s.momentum > 0)
      .sort((a, b) => b.momentum - a.momentum)
      .slice(0, Math.max(0, limits.maxPositions));
    const total = scored.reduce((acc, s) => acc + s.momentum, 0);

    const weights: Record<string, number> = {};
    if (total > 0) {
      const gross = Math.min(limits.grossCap, limits.maxPositions * limits.maxPositionWeight);
      for (const s of scored) {
        const raw = (s.momentum / total) * gross;
        weights[s.symbol] = Number(Math.min(raw, limits.maxPositionWeight).toFixed(6));
      }
    }
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    return {
      weights,
      cashWeight: Number(Math.max(0, 1 - sum).toFixed(6)),
      confidence: 0.5,
      reason: total > 0 ? "横截面动量居前" : "无正动量资产，空仓",
      source: "rules",
      notes: [],
    };
  }
}

export class AIAllocator {
  constructor(
    private readonly baseline: CrossSectionalAllocator,
    private readonly llm: LLMClient | null,
    private readonly limits: AllocationLimits,
  ) {}

  /** 模型是否具备资产配置能力（System One 等可各自实现）。 */
  private get capable(): boolean {
    return Boolean(this.llm?.allocate);
  }

  async allocate(snapshots: AssetSnapshot[]): Promise<AllocationResult> {
    return this.run(snapshots, undefined);
  }

  /**
   * 联合决策入口：把另一路模型的判断通过黑板带进 prompt，
   * 并把自己的结论写回黑板，供对方下一段读取。
   */
  async allocateWithBoard(
    snapshots: AssetSnapshot[],
    board: JointBoard,
    source: DecisionSource,
  ): Promise<AllocationResult> {
    return this.run(snapshots, { board, source });
  }

  private async run(
    snapshots: AssetSnapshot[],
    joint?: { board: JointBoard; source: DecisionSource },
  ): Promise<AllocationResult> {
    if (!this.llm || !this.capable) {
      const base = await this.baseline.allocate(snapshots, this.limits);
      return this.llm
        ? { ...base, source: "fallback", notes: ["模型不支持资产配置，使用动量基线"] }
        : base;
    }
    if (snapshots.length === 0) {
      return { ...(await this.baseline.allocate([], this.limits)), weights: {}, cashWeight: 1 };
    }

    const prompt = buildAllocationPrompt(
      snapshots,
      this.limits,
      joint ? { board: joint.board, source: joint.source } : undefined,
    );
    const symbols = snapshots.map((s) => s.symbol);
    try {
      const text = await this.llm.allocate!(prompt, symbols);
      const decision = parseAllocation(text);
      const normalized = normalizeAllocation(decision, symbols, this.limits);
      log.info(
        "AI 资产配置 -> %s conf=%s%s",
        describeWeights(normalized.weights),
        decision.confidence.toFixed(2),
        normalized.notes.length > 0 ? ` 调整: ${normalized.notes.join("; ")}` : "",
      );
      return {
        weights: normalized.weights,
        cashWeight: normalized.cashWeight,
        confidence: decision.confidence,
        reason: decision.reason,
        source: "ai",
        notes: normalized.notes,
      };
    } catch (err) {
      const base = await this.baseline.allocate(snapshots, this.limits);
      const why = (err as Error).message;
      log.warn("AI 资产配置失败（%s），回退动量基线", why);
      return { ...base, source: "fallback", notes: [`模型输出不可用：${why}`] };
    }
  }
}

function describeWeights(weights: Record<string, number>): string {
  const parts = Object.entries(weights).map(([s, w]) => `${s} ${(w * 100).toFixed(0)}%`);
  return parts.length > 0 ? parts.join(" / ") : "空仓";
}