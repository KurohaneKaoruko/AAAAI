/** 适配器注册表：UI 目录与实例工厂。 */

import { BinanceAdapter } from "./binance.js";
import { GateAdapter } from "./gate.js";
import { EastmoneyAdapter } from "./eastmoney.js";
import { OkxAdapter } from "./okx.js";
import { SimulatedAdapter } from "./simulated.js";
import { StooqAdapter } from "./stooq.js";
import type { AdapterMeta, Connection, ExchangeAdapter } from "./types.js";

export class UnsupportedAdapterError extends Error {
  constructor(adapterId: string) {
    super(`未知的交易所适配器: ${adapterId}`);
    this.name = "UnsupportedAdapterError";
  }
}

/** 全部适配器元信息（UI「交易所目录」用）。 */
export function listAdapterMetas(): AdapterMeta[] {
  return [
    new SimulatedAdapter().meta,
    new BinanceAdapter().meta,
    new GateAdapter().meta,
    new OkxAdapter().meta,
    new EastmoneyAdapter().meta,
    new StooqAdapter().meta,
  ];
}

export function getAdapterMeta(adapterId: string): AdapterMeta | undefined {
  return listAdapterMetas().find((m) => m.id === adapterId);
}

/** 按连接创建适配器实例（带入密钥）。 */
export function createAdapter(connection: Connection, cred: { apiKey: string; apiSecret: string }): ExchangeAdapter {
  switch (connection.adapterId) {
    case "simulated":
      return new SimulatedAdapter();
    case "binance":
      return new BinanceAdapter();
    case "gate":
      return new GateAdapter();
    case "okx":
      return new OkxAdapter();
    case "eastmoney":
      return new EastmoneyAdapter();
    case "stooq":
      return new StooqAdapter();
    default:
      throw new UnsupportedAdapterError(connection.adapterId);
  }
}
