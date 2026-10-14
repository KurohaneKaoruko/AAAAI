/**
 * 资产配置（AI 自己选资产/配权重）的 Prompt 构造与输出解析。

 *
 * 与「单标的仓位决策」（llmClient.ts）的区别：
 * - 单标的决策：模型只回答「这个标的多重」，标的由人指定；
 * - 资产配置：模型回答「这一轮买哪些、各占多少、留多少现金」，标的由候选池给出。
 *
 * 输出 JSON：
 *   { "allocations": { "BTC": 0.45, "ETH": 0.0 }, "cash_weight": 0.55,
 *     "confidence": 0.6, "reason": "..." }
 */



/** 模型给出的原始资产配置（尚未做上限裁剪）。 */
export interface AllocationDecision {
  /** symbol -> 权重（0~1） */
  weights: Record<string, number>;
  /** 模型自报的现金比例（0~1）；仅用于参考，实际以权重和为准 */
  cashWeight: number;
  confidence: number;
  reason: string;
}

/** 单个候选资产的技术面摘要（不含未来信息）。 */
export interface AssetSnapshot {
  symbol: string;
  price: number;
  /** 快慢均线动量 */
  momentum: number;
  /** 最近 5 根涨跌 */
  retShort: number;
  /** 最近 20 根涨跌 */
  retLong: number;
  trend: "up" | "down" | "flat";
  /** 已积累的 K 线数 */
  bars: number;
  /** 模型或规则给出的文字点评（可选） */
  commentary?: string;
}

export interface AllocationLimits {
  /** 最多同时持有几个资产 */
  maxPositions: number;
  /** 单标的上限（占总权益） */
  maxPositionWeight: number;
  /** 组合总仓位上限（所有权重之和） */
  grossCap: number;
}

/** 裁剪后的配置 + 留给日志的说明。 */
export interface NormalizedAllocation {
  weights: Record<string, number>;
  cashWeight: number;
  notes: string[];
}

/** 构造资产配置 Prompt：只给技术面摘要表，不给未来信息。 */
export function buildAllocationPrompt(
  snapshots: AssetSnapshot[],
  limits: AllocationLimits,
): string {
  const rows = snapshots
    .map((s) =>
      [
        s.symbol.padEnd(12),
        `价=${s.price}`,
        `5期=${pctText(s.retShort)}`,
        `20期=${pctText(s.retLong)}`,
        `动量=${s.momentum.toFixed(4)}`,
        `趋势=${s.trend}`,
        s.commentary ? `点评=${s.commentary}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join("\n");

  return [
    "你是一名资产配置经理，需要为组合决定下一轮的资金分配。",
    "",
    "候选资产技术面（由已发生的 K 线计算，没有未来信息）：",
    rows,
    "",
    "硬性约束：",
    `- 最多持有 ${limits.maxPositions} 个资产；`,
    `- 单个资产权重不超过 ${limits.maxPositionWeight}；`,
    `- 所有权重之和不超过 ${limits.grossCap}，其余为现金；`,
    "- 只能使用上面列出的标的，不要发明新标的；",
    "- 方向不明就给 0，空仓是合法且常见的决策；",
    "- 只根据给定数据判断，不要虚构基本面、消息面或价格。",
    "",
    "输出一个 JSON 对象（不要输出任何其他文字）：",
    '{"allocations": {"标的": 0.35}, "cash_weight": 0.4, "confidence": 0.0-1.0, "reason": "不超过50字"}',
  ].join("\n");
}

/**
 * 解析模型输出。容忍 ```json 围栏、allocations 为数组、
 * 以及只给单个 target_weight 的旧格式。
 */
export function parseAllocation(text: string): AllocationDecision {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("模型输出中未找到 JSON 对象");
  const raw = JSON.parse(match[0]) as Record<string, unknown>;

  const weights: Record<string, number> = {};
  const alloc = raw.allocations ?? raw.allocation ?? raw.positions;
  if (Array.isArray(alloc)) {
    // [{ "symbol": "BTC", "weight": 0.4 }, ...]
    for (const item of alloc) {
      const o = item as Record<string, unknown>;
      const symbol = String(o.symbol ?? o.code ?? o.name ?? "").trim();
      const w = Number(o.weight ?? o.target_weight ?? o.value);
      if (symbol && Number.isFinite(w)) weights[symbol] = w;
    }
  } else if (alloc && typeof alloc === "object") {
    for (const [symbol, value] of Object.entries(alloc as Record<string, unknown>)) {
      const w = Number(value);
      if (Number.isFinite(w)) weights[symbol.trim()] = w;
    }
  }

  // 旧格式兜底：{"target_weight": 0.4, "symbol": "BTC"}
  if (Object.keys(weights).length === 0) {
    const single = Number(raw.target_weight ?? raw.targetWeight);
    const symbol = String(raw.symbol ?? "").trim();
    if (Number.isFinite(single) && symbol) weights[symbol] = single;
  }
  if (Object.keys(weights).length === 0) {
    throw new Error("模型输出中没有可用的 allocations");
  }

  const confidence = Number(raw.confidence ?? 0);
  const cashWeight = Number(raw.cash_weight ?? raw.cash ?? NaN);
  return {
    weights,
    cashWeight: Number.isFinite(cashWeight) ? clamp01(cashWeight) : NaN,
    confidence: Number.isFinite(confidence) ? clamp01(confidence) : 0,
    reason: String(raw.reason ?? "").slice(0, 160) || "ai-allocation",
  };
}

/**
 * 把模型给的权重裁剪成可执行配置：
 * 1. 丢掉候选池之外的标的；
 * 2. 负数归零、单标的上限截断；
 * 3. 超过持仓数量时保留权重最大的前 N 个；
 * 4. 总仓位超限时按比例缩放（保留相对置信度）。
 */
export function normalizeAllocation(
  decision: AllocationDecision,
  candidates: string[],
  limits: AllocationLimits,
): NormalizedAllocation {
  const allowed = new Set(candidates);
  const notes: string[] = [];

  const cleaned: { symbol: string; weight: number }[] = [];
  for (const [symbol, value] of Object.entries(decision.weights)) {
    if (!allowed.has(symbol)) {
      notes.push(`丢弃候选池外的标的 ${symbol}`);
      continue;
    }
    if (!Number.isFinite(value)) continue;
    const w = clamp01(value);
    if (value < 0) notes.push(`${symbol} 负权重归零`);
    if (value > 1) notes.push(`${symbol} 权重 ${value} 截断到 1`);
    if (w > 0) cleaned.push({ symbol, weight: Math.min(w, limits.maxPositionWeight) });
  }

  let kept = cleaned.sort((a, b) => b.weight - a.weight);
  if (kept.length > limits.maxPositions) {
    const dropped = kept.slice(limits.maxPositions).map((k) => k.symbol);
    notes.push(`超出持仓上限，放弃 ${dropped.join("、")}`);
    kept = kept.slice(0, limits.maxPositions);
  }

  let sum = kept.reduce((acc, k) => acc + k.weight, 0);
  if (sum > limits.grossCap) {
    const scale = limits.grossCap / sum;
    notes.push(`总仓位 ${sum.toFixed(2)} 超限，按比例压缩到 ${limits.grossCap}`);
    kept = kept.map((k) => ({ ...k, weight: k.weight * scale }));
    sum = kept.reduce((acc, k) => acc + k.weight, 0);
  }

  const weights: Record<string, number> = {};
  for (const k of kept) weights[k.symbol] = Number(k.weight.toFixed(6));
  return { weights, cashWeight: Number(Math.max(0, 1 - sum).toFixed(6)), notes };
}

/** 生成人类可读的一行摘要，用于事件流展示。 */
export function describeAllocation(weights: Record<string, number>, cashWeight: number): string {
  const parts = Object.entries(weights)
    .sort((a, b) => b[1] - a[1])
    .map(([symbol, w]) => `${symbol} ${(w * 100).toFixed(0)}%`);
  const cash = `现金 ${(cashWeight * 100).toFixed(0)}%`;
  return parts.length > 0 ? `${parts.join(" / ")} · ${cash}` : `空仓 · ${cash}`;
}

function pctText(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function clamp01(v: number): number {
  return Math.min(Math.max(v, 0), 1);
}