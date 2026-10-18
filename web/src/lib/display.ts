/**
 * 显示偏好：涨跌颜色与价格符号。
 *
 * 为什么放在浏览器本地而不是服务端配置：这两项只改「这台机器怎么看」
 * （颜色方向、金额前缀），不改任何交易行为 —— 进服务端配置只会让
 * 「换个颜色」变成一件要写文件的事。
 *
 * 涨跌颜色两档：
 *   green-up（默认）绿涨红跌 —— 国际 / 加密行情软件习惯；
 *   red-up          红涨绿跌 —— 中国大陆行情软件习惯。
 * 只对调「行情方向色」（涨跌、盈亏、买卖方向、新闻情绪）。运行中 / 报错
 * 这类系统状态色永远绿=正常、红=危险，不随设置变（见 styles.css 顶部注释）。
 *
 * 本文件是纯逻辑：不碰 DOM、不依赖 React，测试可以直接引用。
 * localStorage 读写与 <html data-updown> 的落地在 useDisplayPrefs.ts。
 */

export type UpDownMode = "green-up" | "red-up";

export interface DisplayPrefs {
  upDown: UpDownMode;
  priceSymbol: string;
}

export const DEFAULT_DISPLAY: DisplayPrefs = { upDown: "green-up", priceSymbol: "" };

/** 价格符号最长 4 个字符：够 ¥ / $ / USDT 这类写法，又不至于把表格撑变形。 */
export const PRICE_SYMBOL_MAX = 4;

export const UP_DOWN_LABEL: Record<UpDownMode, string> = {
  "red-up": "红涨绿跌",
  "green-up": "绿涨红跌",
};

/** 从存储或输入里理出价格符号：非字符串 → 空；去首尾空白；按码点截断（别把 emoji 劈两半）。 */
export function sanitizePriceSymbol(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return Array.from(raw.trim()).slice(0, PRICE_SYMBOL_MAX).join("");
}

/** 解析任意 JSON（localStorage 里可能是任何东西）：坏字段逐个回退默认。 */
export function parseDisplayPrefs(raw: unknown): DisplayPrefs {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    upDown: o.upDown === "red-up" ? "red-up" : "green-up",
    priceSymbol: sanitizePriceSymbol(o.priceSymbol),
  };
}

let current: DisplayPrefs = { ...DEFAULT_DISPLAY };
const listeners = new Set<() => void>();

export function getDisplayPrefs(): DisplayPrefs {
  return current;
}

/** 合并式更新（只改传进来的字段），返回新值；每次变更通知订阅者。 */
export function setDisplayPrefs(patch: Partial<DisplayPrefs>): DisplayPrefs {
  current = {
    upDown: patch.upDown ?? current.upDown,
    priceSymbol: patch.priceSymbol !== undefined ? sanitizePriceSymbol(patch.priceSymbol) : current.priceSymbol,
  };
  for (const fn of listeners) fn();
  return current;
}

export function subscribeDisplayPrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
