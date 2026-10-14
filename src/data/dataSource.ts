/** 数据源抽象：实现方负责把外部行情转换为 Bar。 */

import type { Bar } from "../core/types.js";

export interface FetchBarsOptions {
  symbol: string;
  limit: number;
  interval: string;
}

export interface DataSource {
  readonly name: string;
  fetchBars(options: FetchBarsOptions): Promise<Bar[]>;
}
