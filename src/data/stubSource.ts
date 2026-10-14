/** 桩数据源：确定性随机漫步，无外部依赖，用于冒烟 / 回测 / 演示。 */

import type { Bar } from "../core/types.js";
import type { DataSource, FetchBarsOptions } from "./dataSource.js";

/** 可复现的伪随机数生成器（mulberry32）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller 正态采样。 */
function gauss(rng: () => number): number {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class StubSource implements DataSource {
  readonly name = "stub";

  constructor(private readonly seed = 42) {}

  async fetchBars({ symbol, limit }: FetchBarsOptions): Promise<Bar[]> {
    const rng = mulberry32(this.seed);
    const bars: Bar[] = [];
    let price = 100;
    let ts = Date.now() - limit * 60_000;
    for (let i = 0; i < limit; i += 1) {
      const drift = gauss(rng) * 0.012 + 0.0004;
      price = Math.max(1, price * (1 + drift));
      const open = price * (1 + gauss(rng) * 0.002);
      const close = price;
      const high = Math.max(open, close) * (1 + Math.abs(gauss(rng) * 0.003));
      const low = Math.min(open, close) * (1 - Math.abs(gauss(rng) * 0.003));
      bars.push({
        symbol,
        timestamp: new Date(ts),
        open: round(open),
        high: round(high),
        low: round(low),
        close: round(close),
        volume: round(Math.abs(gauss(rng) * 200 + 1000)),
      });
      ts += 60_000;
    }
    return bars;
  }
}

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
