/**
 * 混合决策：大模型分析行情 → 决策模型做决策。
 *
 * 与「多路加权投票」的区别，也是这个模式存在的意义：
 * - 分析阶段：对话模型只看行情，产出「怎么看」，**不给仓位**（strength/confidence/reason）；
 * - 决策阶段：System One 拿到这份分析作为 state，逐标的定档位，档位概率才换算成目标权重；
 * - 两步职责不重叠，任何一步挂了都能优雅降级（见 hybrid.ts）。
 */

import type { DecisionSource } from "../configSchema.js";
import type { AssetSnapshot } from "./allocation.js";

/** 单个标的的分析结论（不含仓位）。 */
export interface AssetView {
  symbol: string;
  /** 一句话技术面判断 */
  view: string;
  /** 强弱档：strong / moderate / weak（对应决策模型的档位语义） */
  strength: "strong" | "moderate" | "weak";
  confidence: number;
}

export interface MarketAnalysis {
  views: AssetView[];
  /** 从强到弱的排序 */
  ranking: string[];
  summary: string;
  /** 来源：ai = 模型真的分析了；rules = 退化用动量当分析 */
  source: "ai" | "rules";
}

/** 构造行情分析 Prompt：只给已发生的行情，明确要求不要给仓位。 */
export function buildAnalysisPrompt(snapshots: AssetSnapshot[]): string {
  const rows = snapshots
    .map((s) =>
      [
        `${s.symbol} 价=${s.price}`,
        `5期=${pctText(s.retShort)}`,
        `20期=${pctText(s.retLong)}`,
        `均线动量=${s.momentum.toFixed(4)}`,
        `趋势=${s.trend}`,
      ].join(" "),
    )
    .join("\n");

  return [
    "你是行情分析师。下面是候选资产的技术面数据（由已发生的 K 线计算，没有未来信息）：",
    rows,
    "",
    "请只做「分析」，不要给任何仓位或买卖数量。输出一个 JSON 对象（不要输出其他文字）：",
    '{"summary":"不超过60字的整体判断","views":[{"symbol":"标的","view":"一句话技术面判断","strength":"strong|moderate|weak","confidence":0.0-1.0}],"ranking":["从强到弱的标的顺序"]}',
    "约束：",
    "- views 必须覆盖上面列出的每一个标的；",
    "- strength 用 strong / moderate / weak 三档表达技术面强弱；",
    "- 不要虚构基本面、消息面或价格；数据不足就直说。",
  ].join("\n");
}

/** 解析行情分析输出；容忍围栏与缺字段。 */
export function parseAnalysis(text: string, symbols: string[]): MarketAnalysis {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("分析输出中未找到 JSON 对象");
  const raw = JSON.parse(match[0]) as Record<string, unknown>;

  const rawViews = Array.isArray(raw.views) ? raw.views : [];
  const views: AssetView[] = [];
  for (const item of rawViews) {
    const o = (item ?? {}) as Record<string, unknown>;
    const symbol = String(o.symbol ?? "").trim();
    if (!symbol || !symbols.includes(symbol)) continue;
    views.push({
      symbol,
      view: String(o.view ?? "").slice(0, 80) || "未给出判断",
      strength: normalizeStrength(o.strength),
      confidence: clamp01(Number(o.confidence ?? 0.5)),
    });
  }
  if (views.length === 0) throw new Error("分析输出中没有可用的 views");

  const ranking = Array.isArray(raw.ranking)
    ? raw.ranking.map((r) => String(r)).filter((s) => symbols.includes(s))
    : views.map((v) => v.symbol);

  return {
    views,
    ranking: [...new Set(ranking)],
    summary: String(raw.summary ?? "").slice(0, 160),
    source: "ai",
  };
}

/** 用动量兜底的「分析」：模型不可用时至少还有结构化的强弱判断。 */
export function fallbackAnalysis(snapshots: AssetSnapshot[]): MarketAnalysis {
  const sorted = [...snapshots].sort((a, b) => b.momentum - a.momentum);
  return {
    views: sorted.map((s) => ({
      symbol: s.symbol,
      view: `均线动量 ${s.momentum.toFixed(4)}，5 期 ${pctText(s.retShort)}`,
      strength: s.momentum > 0.01 ? "strong" : s.momentum > 0 ? "moderate" : "weak",
      confidence: 0.4,
    })),
    ranking: sorted.map((s) => s.symbol),
    summary: "模型不可用，改用横截面动量作为分析结论",
    source: "rules",
  };
}

/**
 * 把分析结论渲染成 System One 的 state 片段。
 *
 * influence（0~1）决定分析在决策中的地位：
 * - 0     = 决策模型看不到分析，退化为纯决策模型；
 * - (0,1) = 分析作为参考附注；
 * - 1     = 分析作为主要依据，直接写进提问的核心要求。
 */
export function renderAnalysisForState(
  analysis: MarketAnalysis,
  symbols: string[],
  influence: number,
): string {
  if (influence <= 0 || analysis.views.length === 0) return "";
  const w = clamp01(influence);
  const perSymbol = symbols
    .map((s) => {
      const v = analysis.views.find((x) => x.symbol === s);
      if (!v) return `- ${s}：无分析结论`;
      return `- ${s}：${v.view}（技术面强弱=${STRENGTH_ZH[v.strength]}，分析置信度=${v.confidence.toFixed(2)}）`;
    })
    .join("\n");

  const lead =
    w >= 0.99
      ? "分析师的结论是本次定档位的主要依据，请优先依据它。"
      : w >= 0.5
        ? "分析师的结论可作为重要参考，但技术面与你的判断冲突时以你的判断为准。"
        : "分析师的结论仅供参考，信息量有限。";

  return [
    "",
    "【大模型行情分析】",
    `整体判断：${analysis.summary || "（无）"}`,
    `强弱排序：${analysis.ranking.join(" > ") || "（无）"}`,
    perSymbol,
    lead,
    `分析影响力=${(w * 100).toFixed(0)}%`,
  ].join("\n");
}

/** 分析不可用时，直接把「强弱」换算成权重（决策模型掉线的降级路径）。 */
export function analysisToWeights(
  analysis: MarketAnalysis,
  symbols: string[],
): Record<string, number> {
  const base: Record<AssetView["strength"], number> = { strong: 0.6, moderate: 0.35, weak: 0 };
  const weights: Record<string, number> = {};
  for (const s of symbols) {
    const v = analysis.views.find((x) => x.symbol === s);
    const w = v ? base[v.strength] ?? 0 : 0;
    if (w > 0) weights[s] = Number((w * (v?.confidence ?? 0.5)).toFixed(4));
  }
  return weights;
}

export const STRENGTH_ZH: Record<AssetView["strength"], string> = {
  strong: "强",
  moderate: "中",
  weak: "弱",
};

/** 混合决策涉及的两个模型类型（用于配置校验与提示）。 */
export const HYBRID_SOURCES: DecisionSource[] = ["chat", "systemone"];

function normalizeStrength(v: unknown): AssetView["strength"] {
  const s = String(v ?? "").toLowerCase();
  if (s.includes("strong") || s.includes("强")) return "strong";
  if (s.includes("weak") || s.includes("弱")) return "weak";
  return "moderate";
}

function pctText(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
}