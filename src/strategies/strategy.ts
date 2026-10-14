/** 策略抽象：输入 K 线序列，输出目标仓位信号（null = 不动）。 */

import type { Bar, MarketView, Signal } from "../core/types.js";

export interface StrategyContext {
  symbol: string;
  bars: Bar[];
  view?: MarketView;
}

export interface Strategy {
  readonly name: string;
  /** 至少需要多少根 K 线才能给出信号 */
  readonly warmup: number;
  generate(ctx: StrategyContext): Promise<Signal | null>;
}
