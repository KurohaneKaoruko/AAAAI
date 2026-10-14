/**
 * 大模型的工具箱：让决策模型能自己动手查，而不是只能看一段拼好的文本。
 *
 * 设计底线：
 * - **只读**：全部工具都是查询类，没有任何下单/改参数的工具；
 * - **白名单**：模型只能用这里注册过的工具，参数逐一校验；
 * - **有预算**：单次决策的调用轮数与耗时都有限额，见 agentLoop。
 *
 * 工具按「决策时真正需要的五件事」设计：
 *   查新闻 / 看走势 / 看现在什么价 / 看自己现在怎么配的 / 看候选池里有什么
 */

import type { NewsItem } from "../news/types.js";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema（OpenAI function 规范） */
  parameters: Record<string, unknown>;
  /** 一句话用法示例，塞进 prompt 帮助弱模型 */
  example: string;
}

/** 工具能看到的行情/账户上下文（由装配层注入真实实现）。 */
export interface ToolContext {
  candidates(): string[];
  price(symbol: string): number | undefined;
  /** 最近 n 根 K 线的收盘价序列（由旧到新） */
  history(symbol: string, limit: number): { timestamp: string; close: number }[];
  /** 当前账户：权益、现金、各标的权重 */
  allocation(): {
    equity: number;
    cash: number;
    cashWeight: number;
    holdings: { symbol: string; weight: number; marketValue: number; unrealizedPnl: number }[];
  };
  /** 当前账户表现 */
  performance(): { totalReturn: number; maxDrawdownPct: number; totalFills: number; openPositions: number };
  /** 查新闻 */
  news(symbol: string, limit: number): Promise<NewsItem[]>;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export class ToolBox {
  private readonly specs: ToolSpec[];
  private readonly handlers: Record<string, (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>>;

  constructor(
    specs: ToolSpec[],
    handlers: Record<string, (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>>,
  ) {
    this.specs = specs;
    this.handlers = handlers;
  }

  list(): ToolSpec[] {
    return this.specs;
  }

  has(name: string): boolean {
    return Boolean(this.handlers[name]);
  }

  /** 执行一次工具调用；未知工具/参数不合法都会明确报错，不静默吞掉。 */
  async invoke(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const handler = this.handlers[name];
    if (!handler) return { ok: false, error: `没有名为 ${name} 的工具（可用：${this.specs.map((s) => s.name).join(", ")}）` };
    const args = typeof rawArgs === "string" ? safeParse(rawArgs) : (rawArgs ?? {});
    if (typeof args !== "object" || Array.isArray(args)) {
      return { ok: false, error: `${name} 的参数必须是对象` };
    }
    try {
      return await handler(args as Record<string, unknown>, ctx);
    } catch (err) {
      return { ok: false, error: `${name} 执行失败: ${(err as Error).message}` };
    }
  }
}

/** 默认工具箱：行情 / 走势 / 配置 / 持仓 / 候选池 / 新闻。 */
export function defaultToolBox(): ToolBox {
  const specs: ToolSpec[] = [
    {
      name: "search_news",
      description: "搜索该标的最近的新闻/公告/消息，返回标题、时间与情绪倾向（-1极空 ~ +1极多）",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "标的代码，如 600519 / BTCUSDT" },
          limit: { type: "integer", description: "返回条数，1-10，默认 5" },
        },
        required: ["symbol"],
      },
      example: '{"symbol":"600519","limit":5}',
    },
    {
      name: "get_history",
      description: "取该标的最近 N 根 K 线的收盘价，用于判断历史走向、趋势与回撤",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          limit: { type: "integer", description: "根数，5-200，默认 60" },
        },
        required: ["symbol"],
      },
      example: '{"symbol":"600519","limit":60}',
    },
    {
      name: "get_quote",
      description: "取该标的最新价（当前模拟/实时行情快照）",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
      example: '{"symbol":"600519"}',
    },
    {
      name: "get_allocation",
      description: "查看当前账户的资产配置：权益、现金比例、各持仓权重与浮动盈亏",
      parameters: { type: "object", properties: {} },
      example: "{}",
    },
    {
      name: "get_performance",
      description: "查看当前账户表现：累计收益、最大回撤、成交笔数、持仓数",
      parameters: { type: "object", properties: {} },
      example: "{}",
    },
    {
      name: "list_candidates",
      description: "列出候选池里所有可选标的（你只能在这份名单里选）",
      parameters: { type: "object", properties: {} },
      example: "{}",
    },
  ];

  const handlers: ToolBox["handlers"] = {
    search_news: async (args, ctx) => {
      const symbol = str(args.symbol);
      if (!symbol) return { ok: false, error: "缺少 symbol" };
      const limit = clampInt(args.limit, 1, 10, 5);
      const items = await ctx.news(symbol, limit);
      return {
        ok: true,
        data: items.length === 0 ? { symbol, news: [], note: "该标的近期没有抓到新闻" } : { symbol, news: items },
      };
    },

    get_history: async (args, ctx) => {
      const symbol = str(args.symbol);
      if (!symbol) return { ok: false, error: "缺少 symbol" };
      const limit = clampInt(args.limit, 5, 200, 60);
      const series = ctx.history(symbol, limit);
      if (series.length === 0) return { ok: false, error: `没有 ${symbol} 的 K 线数据` };
      const first = series[0]!.close;
      const last = series[series.length - 1]!.close;
      return {
        ok: true,
        data: {
          symbol,
          count: series.length,
          first,
          last,
          changePct: first === 0 ? 0 : Number(((last - first) / first).toFixed(6)),
          maxDrawdownPct: drawdown(series.map((p) => p.close)),
          closes: series.map((p) => p.close),
          times: series.map((p) => p.timestamp),
        },
      };
    },

    get_quote: async (args, ctx) => {
      const symbol = str(args.symbol);
      if (!symbol) return { ok: false, error: "缺少 symbol" };
      const price = ctx.price(symbol);
      if (price === undefined) return { ok: false, error: `没有 ${symbol} 的最新价` };
      return { ok: true, data: { symbol, price } };
    },

    get_allocation: async (_args, ctx) => ({ ok: true, data: ctx.allocation() }),
    get_performance: async (_args, ctx) => ({ ok: true, data: ctx.performance() }),
    list_candidates: async (_args, ctx) => ({ ok: true, data: { candidates: ctx.candidates() } }),
  };

  return new ToolBox(specs, handlers);
}

/** 最大回撤（收盘价序列）。 */
function drawdown(closes: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    if (peak > 0) {
      const dd = (c - peak) / peak;
      if (dd < worst) worst = dd;
    }
  }
  return Number(worst.toFixed(6));
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim().toUpperCase() : "";
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}