/** 币安行情源：公共 K 线接口（无需 Key），用于真实数据回测 / live 模式。 */

import type { Bar } from "../core/types.js";
import type { DataSource, FetchBarsOptions } from "./dataSource.js";
import { StubSource } from "./stubSource.js";
import { getLogger } from "../core/logger.js";

const log = getLogger("binance");

/** 币安 K 线原始行：[openTime, open, high, low, close, volume, closeTime, ...] */
type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

export class BinanceSource implements DataSource {
  readonly name = "binance";

  constructor(private readonly baseUrl = "https://api.binance.com") {}

  async fetchBars({ symbol, limit, interval }: FetchBarsOptions): Promise<Bar[]> {
    const url = `${this.baseUrl}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
    log.debug("GET %s", url);
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      throw new Error(`Binance klines ${symbol} 失败: HTTP ${res.status}`);
    }
    const raw = (await res.json()) as RawKline[];
    return raw.map((k) => ({
      symbol,
      timestamp: new Date(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }));
  }
}

/** 按配置工厂创建数据源。 */
export function createDataSource(source: string, seed: number): DataSource {
  switch (source) {
    case "binance":
      return new BinanceSource();
    default:
      return new StubSource(seed);
  }
}
