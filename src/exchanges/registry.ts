/** 适配器注册表：UI 目录与实例工厂。 */

import { BinanceAdapter } from "./binance.js";
import { GateUnifiedAdapter, gateCatalogMeta } from "./gateUnified.js";
import { OkxAdapter } from "./okx.js";
import { StooqAdapter } from "./stooq.js";
import type { AdapterMeta, Connection, ExchangeAdapter } from "./types.js";

export class UnsupportedAdapterError extends Error {
  constructor(adapterId: string) {
    super(`未知的交易所适配器: ${adapterId}`);
    this.name = "UnsupportedAdapterError";
  }
}

/**
 * 测试运行时标记：`AAAAI_TESTBED=1` 由 test/helpers.ts 统一设置。
 *
 * 测试需要离线、确定性的行情源（真实交易所会让 CI 又慢又不稳），
 * 但它**不该出现在产品里**——模拟交易所已按「一切以实盘数据为准」下线。
 * 测试启动时用 registerTestAdapter() 注入一个 `testbed` 适配器，
 * 目录与工厂对生产环境完全不暴露它。
 */
export function isTestRuntime(): boolean {
  return process.env.AAAAI_TESTBED === "1";
}

/** 测试注入的适配器工厂与元信息（testbed）。生产恒为空。 */
let testAdapterFactory: ((connection: Connection) => ExchangeAdapter) | null = null;
let testAdapterMeta: AdapterMeta | null = null;

/**
 * 仅限测试：注入离线行情适配器工厂。
 * 不放在 test/ 而留这个口子，是因为 ConnectionManager 只认注册表里的 ID；
 * 测试要从 create({adapterId}) 一路走到 adapter()，就得有个能注册的 ID。
 */
export function registerTestAdapter(factory: (connection: Connection) => ExchangeAdapter, meta: AdapterMeta): void {
  if (!isTestRuntime()) throw new Error("registerTestAdapter 仅在测试运行时可用");
  testAdapterFactory = factory;
  testAdapterMeta = meta;
}

/**
 * 历史适配器 ID → 现行 ID 的迁移表。
 *
 * 模拟交易所/模拟合约已按「一切以实盘数据为准」下线；Gate 现货与合约
 * 合并为一条连接。老数据文件（connections.json）里存着旧 ID 的连接，
 * 加载时按这张表自动改写，用户无感。
 */
export const ADAPTER_MIGRATIONS: Record<string, string> = {
  simulated: "__removed__",
  "simulated-futures": "__removed__",
  "gate-futures": "gate",
};

/** 全部适配器元信息（UI「交易所目录」用）。 */
export function listAdapterMetas(): AdapterMeta[] {
  const metas: AdapterMeta[] = [
    new BinanceAdapter().meta,
    gateCatalogMeta(),
    new OkxAdapter().meta,
    new StooqAdapter().meta,
  ];
  // testbed 只在测试运行时出现：目录/表单校验认识这个 ID，产品环境不可见
  if (isTestRuntime() && testAdapterMeta) metas.push(testAdapterMeta);
  return metas;
}

export function getAdapterMeta(adapterId: string): AdapterMeta | undefined {
  return listAdapterMetas().find((m) => m.id === adapterId);
}

/** 按连接创建适配器实例（带入密钥）。 */
export function createAdapter(connection: Connection, cred: { apiKey: string; apiSecret: string }): ExchangeAdapter {
  switch (connection.adapterId) {
    case "binance":
      return new BinanceAdapter();
    case "gate":
      // 统一 Gate：一条连接覆盖现货/永续，按连接的 tradingMode 决定行为
      return new GateUnifiedAdapter(connection);
    case "okx":
      return new OkxAdapter();
    case "stooq":
      return new StooqAdapter();
    case "testbed":
      // 仅测试运行时可达（helpers 注入工厂后 ID 才有效）；生产落到 default 抛错
      if (testAdapterFactory) return testAdapterFactory(connection);
      throw new UnsupportedAdapterError(connection.adapterId);
    default:
      throw new UnsupportedAdapterError(connection.adapterId);
  }
}
