/**
 * 联合决策：对话模型（chat）与 System One 决策模型（systemone）一起做决策。
 *
 * 与「两路独立算完再加权平均」的区别（这是本文件存在的理由）：
 * - 两路共享同一块 JointBoard，后手能看到先手的结论；
 * - 顺序执行：先手先给判断，后手在该判断上细化（System One 的 state 里带对话模型的研判）；
 * - 先手下一轮能看到后手上一轮的档位判断，于是两轮之间也形成回路；
 * - 最终仓位仍按配比加权，并重新过一次额度裁剪（单标的/总仓位/持仓数）。
 *
 * 任一路没有可用实例或调用失败 -> 自动降级为单路，不影响出单。
 */

import { getLogger } from "../core/logger.js";
import type { DecisionSource } from "../configSchema.js";
import type { Signal } from "../core/types.js";
import { JointBoard, SOURCE_ZH } from "../llm/jointBoard.js";
import { normalizeAllocation, type AllocationLimits, type AssetSnapshot } from "../llm/allocation.js";
import type { AIAllocator, AllocationResult } from "./allocator.js";
import { blendRatios, blendWeightMaps } from "./blend.js";
import type { Strategy, StrategyContext } from "./strategy.js";

const log = getLogger("joint");

export interface JointLanes {
  chat: AIAllocator | null;
  systemone: AIAllocator | null;
  /** 各路配比（相对权重，展示时归一化） */
  blend: Record<DecisionSource, number>;
}

/** 把一路的结论写进黑板，供另一路下一段读取。 */
function record(board: JointBoard, source: DecisionSource, weights: Record<string, number>, note: string): void {
  const perSymbol: Record<string, string> = {};
  for (const [symbol, w] of Object.entries(weights)) {
    if (w > 0) perSymbol[symbol] = `${(w * 100).toFixed(0)}%`;
  }
  board.set(source, { note, perSymbol });
}

/**
 * 资产配置模式的联合决策器。
 * 实现与 AIAllocator 相同的接口，可直接塞进 AllocatorAgent。
 */
export class JointAllocator {
  private readonly board = new JointBoard();

  constructor(
    private readonly lanes: JointLanes,
    private readonly limits: AllocationLimits,
  ) {}

  async allocate(snapshots: AssetSnapshot[]): Promise<AllocationResult> {
    const only = this.single();
    if (only) return only.allocator.allocate(snapshots);

    const symbols = snapshots.map((s) => s.symbol);
    const notes: string[] = [];

    // 先手：对话模型（首轮没有 System One 的历史判断）
    const chat = await this.run("chat", this.lanes.chat, snapshots, symbols, notes);
    // 后手：System One 的 state 里已带上对话模型的研判
    const so = await this.run("systemone", this.lanes.systemone, snapshots, symbols, notes);

    const maps = {
      rules: {},
      chat: chat?.weights ?? {},
      systemone: so?.weights ?? {},
    };
    const lanes: { source: DecisionSource; weight: number; available: boolean }[] = [
      { source: "chat", weight: this.lanes.blend.chat, available: Boolean(chat) },
      { source: "systemone", weight: this.lanes.blend.systemone, available: Boolean(so) },
    ];
    const blended = blendWeightMaps(lanes, maps);
    const ratios = blendRatios(lanes);

    const normalized = normalizeAllocation(
      { weights: blended.weights, cashWeight: 0, confidence: 0, reason: "" },
      symbols,
      this.limits,
    );

    const reasons: string[] = [];
    let confidence = 0;
    if (chat) {
      reasons.push(`${SOURCE_ZH.chat}: ${clip(chat.reason, 40)}`);
      confidence += (ratios.ratios.chat || 0) * chat.confidence;
    }
    if (so) {
      reasons.push(`${SOURCE_ZH.systemone}: ${clip(so.reason, 40)}`);
      confidence += (ratios.ratios.systemone || 0) * so.confidence;
    }
    if (blended.conflict) notes.push(blended.conflict);

    log.info(
      "联合决策 %s%s",
      describe(normalized.weights),
      chat && so ? "（两路均已参考对方结论）" : "（单路，另一路不可用）",
    );

    return {
      weights: normalized.weights,
      cashWeight: normalized.cashWeight,
      confidence: Number(confidence.toFixed(4)),
      reason: reasons.join(" ⟷ ") || "联合决策",
      source: "mix",
      notes: [...normalized.notes, ...notes],
    };
  }

  /** 单路可用时直接用它，避免无谓的编排。 */
  private single(): { allocator: AIAllocator } | null {
    const chat = this.lanes.chat && this.lanes.blend.chat > 0 ? this.lanes.chat : null;
    const so = this.lanes.systemone && this.lanes.blend.systemone > 0 ? this.lanes.systemone : null;
    if (chat && !so) return { allocator: chat };
    if (so && !chat) return { allocator: so };
    return null;
  }

  /** 跑一路：写黑板 -> 读另一路的黑板 -> 调用 -> 记录结论。 */
  private async run(
    source: DecisionSource,
    allocator: AIAllocator | null,
    snapshots: AssetSnapshot[],
    symbols: string[],
    notes: string[],
  ): Promise<AllocationResult | null> {
    if (!allocator || this.lanes.blend[source] <= 0) return null;
    try {
      const result = await allocator.allocateWithBoard(snapshots, this.board, source);
      record(this.board, source, result.weights, result.reason);
      return result;
    } catch (err) {
      notes.push(`${SOURCE_ZH[source]}本轮失败，仅另一路参与：${(err as Error).message}`);
      log.warn("%s 联合决策失败: %s", source, (err as Error).message);
      return null;
    }
  }
}

/** 逐标的模式的联合决策器（与 JointAllocator 同思路，输出单标的目标仓位）。 */
export class JointStrategy implements Strategy {
  readonly name = "joint";
  readonly warmup: number;
  private readonly board = new JointBoard();

  constructor(
    private readonly chat: Strategy | null,
    private readonly so: Strategy | null,
    private readonly blend: Record<DecisionSource, number>,
    warmup: number,
  ) {
    this.warmup = warmup;
    // 把同一块黑板交给两路：LLMStrategy 会在 prompt 里带上对方的判断，
    // 并把自己的结论写回黑板 —— 这才是「一起决策」而非各自盲猜后平均。
    share(this.chat, this.board, "chat");
    share(this.so, this.board, "systemone");
  }

  async generate(ctx: StrategyContext): Promise<Signal | null> {
    const chat = this.chat && this.blend.chat > 0 ? this.chat : null;
    const so = this.so && this.blend.systemone > 0 ? this.so : null;
    if (!chat || !so) {
      // 单路：没有先后手可言，退回单策略
      const only = chat ?? so;
      return only ? only.generate(ctx) : null;
    }

    const chatSignal = await this.safe("chat", chat, ctx);
    if (chatSignal) {
      this.board.set("chat", {
        note: clip(chatSignal.reason, 160),
        perSymbol: { [ctx.symbol]: `${(chatSignal.targetWeight * 100).toFixed(0)}%` },
      });
    }
    const soSignal = await this.safe("systemone", so, ctx);
    if (soSignal) {
      this.board.set("systemone", {
        note: clip(soSignal.reason, 160),
        perSymbol: { [ctx.symbol]: `${(soSignal.targetWeight * 100).toFixed(0)}%` },
      });
    }
    if (!chatSignal && !soSignal) return null;

    const { ratios } = blendRatios([
      { source: "chat", weight: this.blend.chat, available: Boolean(chatSignal) },
      { source: "systemone", weight: this.blend.systemone, available: Boolean(soSignal) },
    ]);
    let weight = 0;
    let confidence = 0;
    const reasons: string[] = [];
    if (chatSignal) {
      weight += (ratios.chat || 0) * chatSignal.targetWeight;
      confidence += (ratios.chat || 0) * chatSignal.confidence;
      reasons.push(`${SOURCE_ZH.chat}: ${clip(chatSignal.reason, 30)}`);
    }
    if (soSignal) {
      weight += (ratios.systemone || 0) * soSignal.targetWeight;
      confidence += (ratios.systemone || 0) * soSignal.confidence;
      reasons.push(`${SOURCE_ZH.systemone}: ${clip(soSignal.reason, 30)}`);
    }
    const final = Math.min(Math.max(weight, 0), 1);
    if (final <= 0) return null;
    return {
      symbol: ctx.symbol,
      timestamp: (chatSignal ?? soSignal)!.timestamp,
      targetWeight: Number(final.toFixed(6)),
      confidence: Number(confidence.toFixed(4)),
      reason: `[联合] ${reasons.join(" ⟷ ")}`,
    };
  }

  private async safe(
    source: DecisionSource,
    strategy: Strategy,
    ctx: StrategyContext,
  ): Promise<Signal | null> {
    try {
      return await strategy.generate(ctx);
    } catch (err) {
      log.warn("%s 联合决策失败: %s", source, (err as Error).message);
      return null;
    }
  }
}

function describe(weights: Record<string, number>): string {
  const parts = Object.entries(weights)
    .sort((a, b) => b[1] - a[1])
    .map(([s, w]) => `${s} ${(w * 100).toFixed(0)}%`);
  return parts.length > 0 ? parts.join(" / ") : "空仓";
}

function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

function share(strategy: Strategy | null, board: JointBoard, source: DecisionSource): void {
  const aware = strategy as { setBoard?: (b: JointBoard, s: DecisionSource) => void } | null;
  if (aware && typeof aware.setBoard === "function") aware.setBoard(board, source);
}