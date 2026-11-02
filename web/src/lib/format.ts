/** 格式化工具。 */

import { getDisplayPrefs } from "./display";

/**
 * 金额格式化。
 *
 * 设了「价格符号」（设置页）就加在最前面；不设时与从前逐字节一致 ——
 * 这是「这个设置只改显示」这句话能被核对的前提。
 * 负数把符号插在减号与数字之间：-¥5.00，而不是 ¥-5.00。
 */
export const money = (v: number, digits = 2): string => {
  const body = v.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const symbol = getDisplayPrefs().priceSymbol;
  if (!symbol) return body;
  return body.startsWith("-") ? `-${symbol}${body.slice(1)}` : `${symbol}${body}`;
};

export const pct = (v: number, digits = 2): string => `${(v * 100).toFixed(digits)}%`;

/**
 * 权重显示。
 *
 * 小权重要看得清（0.2% 不能显示成 0%）；同时至少保留 1 位小数 ——
 * 这一栏是给人数用的，33.3% 显示成 33% 时几项加起来会差 1%，
 * 看着像"少了钱"，用户没法判断该信哪个。
 */
export const wPct = (w: number): string => {
  const digits = w > 0 && w < 0.01 ? 2 : 1;
  return `${(w * 100).toFixed(digits)}%`;
};

/**
 * 权重栏里的"其余"（现金）：按与 wPct 相同的显示精度算 1 - Σ权重。
 *
 * 这样这一栏**看得见地加总到 100%**。若直接显示原始 cashWeight，
 * 各持仓四舍五入的零头会露出来（33.3+33.3+1.0+32.3 = 99.9%，
 * 甚至 33+33+1+32 = 99%），用户会以为"少了钱"。
 * 与真实 cashWeight 的差异不超过 Σ 各持仓的半档舍入。
 */
export const weightRemainder = (weights: number[]): number => {
  const shown = weights.reduce((s, w) => s + Number(wPct(w).replace("%", "")), 0);
  return Math.max(0, Number((100 - shown).toFixed(1)) / 100);
};

export const signed = (v: number, digits = 2): string =>
  `${v >= 0 ? "+" : ""}${money(v, digits)}`;

/**
 * 带符号的百分比：盈亏类百分比永远带 +/− 与颜色配合使用。
 * 「3.20%」看不出方向，「+3.20%」一眼就是涨 —— 量化界面里省掉的每个符号都要用颜色补回来。
 */
export const signedPct = (v: number, digits = 2): string =>
  `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;

/**
 * 运行时长：秒 → 人话（45s / 3分12秒 / 2时05分 / 1天3时）。
 * 机器人列表与详情共用：长跑的机器人显示成 12345s 没法读。
 */
export const duration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${String(s % 60).padStart(2, "0")}秒`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}时${String(m % 60).padStart(2, "0")}分`;
  return `${Math.floor(h / 24)}天${h % 24}时`;
};

export const qty = (v: number, precision = 6): string => {
  if (Math.abs(v) >= 1000) return v.toFixed(2);
  return v.toFixed(Math.min(precision, 6)).replace(/0+$/, "").replace(/\.$/, "") || "0";
};

export const time = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
};

export const dateTime = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString("zh-CN")} ${time(iso)}`;
};

/**
 * 成交时间：同一天内只给时分秒，跨天则带上日期。
 *
 * 日线回放里几十笔成交全落在同一个时刻，只显示时分秒会让整张表看起来
 * 像"同一秒成交了一堆单" —— 那是显示骗人，不是事实。
 */
export const tradeTime = (iso: string, spanDays: boolean): string =>
  spanDays ? `${new Date(iso).toLocaleDateString("zh-CN")} ${time(iso)}` : time(iso);

export const ASSET_LABEL: Record<string, string> = {
  crypto: "加密货币",
  stock: "股票",
  mixed: "全品类",
};

/**
 * 表格里"你持有的那个东西"这一列该叫什么。
 *
 * 真实交易所里是标的（BTCUSDT / AAPL）；模拟交易所没有标的，它的交易物是
 * 几条本地生成的**行情走向**（单边上行 / 急速跳水…）。一律写"标的"就是在
 * 指着一堆走向叫标的 —— 那个词在这里是错的。
 */
export const symbolColumnLabel = (builtinSymbols: boolean | undefined): string =>
  builtinSymbols ? "走向" : "标的";

export const TOPIC_LABEL: Record<string, string> = {
  "market.bar": "K线",
  "agent.market_view": "分析",
  "strategy.signal": "信号",
  "strategy.allocation": "配置",
  "exec.order_intent": "下单",
  "exec.order_rejected": "拒单",
  "exec.fill": "成交",
  "engine.status": "引擎",
};