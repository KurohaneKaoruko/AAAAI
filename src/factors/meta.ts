/**
 * 因子元数据（纯数据，不引任何运行时依赖）。
 *
 * 服务端计算与 WebUI 展示共用同一份定义，避免两边写岔。
 */

export type FactorName = "trend" | "momentum" | "breakout" | "reversal" | "volume";

export interface FactorMeta {
  name: FactorName;
  label: string;
  desc: string;
  defaultWeight: number;
}

export const FACTOR_META: FactorMeta[] = [
  {
    name: "trend",
    label: "趋势强度",
    desc: "快慢均线的相对位置，叠加上涨 K 线占比，衡量趋势是否扎实",
    defaultWeight: 1,
  },
  {
    name: "momentum",
    label: "中期动量",
    desc: "近 20 根累计收益，按波动率调整（低波动的同幅上涨得分更高）",
    defaultWeight: 1,
  },
  {
    name: "breakout",
    label: "区间突破",
    desc: "收盘价相对近 60 根高低点的位置，衡量是否处在新高/新低附近",
    defaultWeight: 0.6,
  },
  {
    name: "reversal",
    label: "短期反转",
    desc: "近 5 根 z-score 取负：跌得多的更容易反弹（适合震荡市）",
    defaultWeight: 0,
  },
  {
    name: "volume",
    label: "量价配合",
    desc: "OBV 近端斜率与价格方向是否同向，区分放量上涨与缩量上涨",
    defaultWeight: 0.4,
  },
];