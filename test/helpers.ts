/** 测试公共工具：配置构造与 K 线构造。 */

import { buildConfig } from "../src/configSchema.js";
import type { AppConfig } from "../src/configSchema.js";
import type { Bar } from "../src/core/types.js";
import { SimulatedAdapter } from "../src/exchanges/simulated.js";
import type { ExchangeAdapter } from "../src/exchanges/types.js";

export type { AppConfig, Bar };

export function makeBars(closes: number[], symbol = "TEST"): Bar[] {
  const now = Date.now();
  return closes.map((c, i) => ({
    symbol,
    timestamp: new Date(now + i * 60_000),
    open: c,
    high: c * 1.001,
    low: c * 0.999,
    close: c,
    volume: 1,
  }));
}

/** 测试用配置：模拟交易所 + paper 券商 + 无 LLM，零外部依赖。 */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = buildConfig({
    app: { name: "TEST", log_level: "error" },
    market: { symbols: ["仓位1"], interval: "1m", bar_count: 120, poll_ms: 60_000 },
    strategy: { name: "momentum", fast_window: 5, slow_window: 20, max_target_weight: 0.5 },
    risk: {
      initial_cash: 100_000,
      fee_rate: 0.0003,
      slippage_bps: 2,
      max_order_value: 20_000,
      max_position_weight: 0.6,
      max_drawdown_pct: 0.15,
    },
    execution: { mode: "paper", connection_id: "" },
    llm: { enabled: false },
  });
  return { ...base, ...overrides };
}

/** 已 init 的模拟适配器（离线、确定性）。 */
/**
 * 测试用的模拟行情必须可复现。
 *
 * 模拟交易所默认每个情景都是新掷的随机路径（这是它存在的意义：策略要在
 * 不可预测的行情上被考察）。但"等成交出现""更大资金下更大的单"这类断言
 * 不能建立在随机数上 —— 那等于让 CI 靠运气过。所以测试统一锁一个种子，
 * 换成别的种子可能让某些用例因"行情恰好没走出信号"而失败（这是有意的：
 * 它提醒我们那些用例测的是信号出现之后的链路，不测信号本身）。
 *
 * 随机性本身由 test/scenario.test.ts 单独验证（它会清掉这个变量）。
 *
 * 种子与下面的时刻是**配套的一对**：价格是 (情景种子, 槽名, 时刻) 的纯函数，
 * 所以把模拟交易所的仓位槽改名（曾经叫 DEMO-*，现在叫仓位1~仓位4），
 * 整条路径就重掷了一遍，原来那对取值里"刚好走出信号"的窗口不再成立。
 * 动过槽名或时刻之后要重新挑一对 —— 判据是 test/bots.test.ts 与
 * test/backtest.test.ts 双双全绿（2026-10 改槽名后用的就是这一对）。
 */
process.env.AAAAI_SIM_SEED ??= "12";

// 光锁种子还不够：路径是时间的函数，不锁时刻的话，换个钟点跑出来的窗口
// 就整体平移，"刚好走出信号"变成碰运气。这里把模拟时钟钉死，测试因此
// 完全确定：同一份行情、同一条决策、同样的成交。
//
// 这一对取值不是随手挑的：它是按"预热之后只再给 3 根实时 K 线"这个真实
// 条件筛出来的（机器人用例里可得的实时数据就这么多），六种配置全部能在
// 这 3 根里走出信号。换一组取值可能让某些用例因行情恰好没走出信号而失败 ——
// 那说明那条用例在赌行情运气，该改用例而不是改种子。
//
// 反过来，回测用例要的是"这段窗口里有均线交叉"，与上面这条互相牵制：
// 挑种子时两个文件一起跑，别只看一个。日期是 2026-10 挑的。
process.env.AAAAI_SIM_NOW ??= String(Date.UTC(2026, 1, 23, 3, 0, 0));

export function testAdapter(): ExchangeAdapter {
  const adapter = new SimulatedAdapter();
  adapter.init({ apiKey: "", apiSecret: "", testnet: false });
  return adapter;
}