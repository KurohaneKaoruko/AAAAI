/**
 * 联合决策板（黑板）：让对话模型与 System One 决策模型「一起决策」的关键。
 *
 * 纯加权平均不算一起决策——两路各看各的，互不知情，融合只是投票。
 * 这里把每一路的结论留在共享黑板上：
 * - 对话模型在出结论前，能看到 System One 上一轮/本轮对各标的的档位概率；
 * - System One 在构造 state 时，能看到对话模型本轮对各标的的研判与排序。
 *
 * 于是两路形成前后手：一路先给判断，另一路在这个判断上细化，
 * 最终权重再按配比融合。任何一方缺失（没配实例/调用失败）都自动降级为单路。
 */

import type { DecisionSource } from "../configSchema.js";

export const SOURCE_ZH: Record<DecisionSource, string> = {
  rules: "纯规则",
  chat: "对话模型",
  systemone: "决策模型",
};

export interface BoardEntry {
  /** 该路的原始结论（截断后） */
  note: string;
  /** 该路对各标的的判断：标的 -> 档位/观点 */
  perSymbol?: Record<string, string>;
}

export class JointBoard {
  private entries = new Map<DecisionSource, BoardEntry>();

  /** 记录一路的结论（供其他路读取）。 */
  set(source: DecisionSource, entry: BoardEntry): void {
    this.entries.set(source, { note: clip(entry.note, 200), perSymbol: entry.perSymbol });
  }

  get(source: DecisionSource): BoardEntry | undefined {
    return this.entries.get(source);
  }

  /** 除了 exclude 之外的路的所有结论。 */
  others(exclude: DecisionSource): { source: DecisionSource; entry: BoardEntry }[] {
    return [...this.entries.entries()]
      .filter(([source]) => source !== exclude)
      .map(([source, entry]) => ({ source, entry }));
  }

  /**
   * 渲染成给模型看的一段文字（放在决策 prompt 的行情描述之后、约束之前）。
   * 空板返回空串，调用方直接跳过。
   */
  renderOthers(exclude: DecisionSource, limit = 3): string {
    const rows = this.others(exclude);
    if (rows.length === 0) return "";
    const lines: string[] = [];
    for (const { source, entry } of rows.slice(0, limit)) {
      const per = entry.perSymbol
        ? `：${Object.entries(entry.perSymbol)
            .slice(0, 5)
            .map(([symbol, view]) => `${symbol}=${view}`)
            .join("、")}`
        : "";
      lines.push(`- ${SOURCE_ZH[source]}的判断${per}`);
      if (entry.note) lines.push(`  理由：${entry.note}`);
    }
    return ["", "其他决策路（本系统内的另一路模型）的判断，供你参考，可同意也可反对：", ...lines].join("\n");
  }
}

function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}