/**
 * 模拟交易所：本地随机行情 + 模拟成交。
 *
 * 存在的理由只有一个：**在可控的随机行情上考察策略**。
 * 所以路径必须是随机掷出来的 —— 早期版本按 symbol 哈希播种，同一代码每次
 * 走势完全相同，那测出来的只是"一条任意路径上的运气"，换个策略比也不公平。
 *
 * 但随机不等于失控，三条性质缺一不可：
 * 1. **情景内自洽**：价格是 (情景种子, 标的, 时刻) 的纯函数，不依赖取数顺序。
 *    同一窗口反复取结果一致，实时轮询不会自己改写历史，历史模拟的
 *    预热段和后续成交必然对得上。
 * 2. **随时间向前**：K 线只往后长。行情永远"生成到此刻为止"，没有任何一根
 *    K 线能用到的信息出现在它之前。
 * 3. **可按需复现**：情景带种子并记进结果。想复现某次随机结果就把种子填回去
 *    （环境变量 SIM_SEED / SIM_NOW，或接口参数 scenarioSeed），默认每次都是新的一条路径。
 */

import { readEnv } from "../env.js";
import type { Bar, Side } from "../core/types.js";
import type {
  AdapterMeta,
  ConnectionTest,
  Credential,
  ExchangeAdapter,
  OrderRequest,
  OrderResult,
  SymbolInfo,
  Ticker,
} from "./types.js";

const DEMO_SYMBOLS: SymbolInfo[] = [
  { symbol: "DEMO-BTC", name: "模拟比特币", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 2, qtyPrecision: 6 },
  { symbol: "DEMO-ETH", name: "模拟以太坊", assetClass: "crypto", currency: "USDT", lotSize: 1, pricePrecision: 2, qtyPrecision: 6 },
  { symbol: "600519", name: "模拟茅台", assetClass: "stock", currency: "CNY", lotSize: 100, pricePrecision: 2, qtyPrecision: 0 },
  { symbol: "AAPL", name: "模拟苹果", assetClass: "stock", currency: "USD", lotSize: 1, pricePrecision: 2, qtyPrecision: 0 },
];

/** 随机游走的快频带：周期从 4 根到 80 根（几何分布）。 */
const FAST_MIN_PERIOD = 4;
const FAST_MAX_PERIOD = 80;
const FAST_COMPONENTS = 8;
/** 慢趋势周期（根）：窗口内表现为一段平滑的上行/下行/横盘，即"行情风格"。 */
const SLOW_PERIOD = 900;

const FAST_RATIO = (FAST_MAX_PERIOD / FAST_MIN_PERIOD) ** (1 / (FAST_COMPONENTS - 1));

/** 字符串哈希 → 32 位无符号数（FNV-1a）。 */
function hashOf(...parts: (string | number)[]): number {
  let h = 2166136261;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 由哈希派生的 [0,1) 均匀随机（同一入参必得同值，与调用顺序无关）。 */
function randOf(...parts: (string | number)[]): number {
  let a = hashOf(...parts);
  a = (a + 0x6d2b79f5) >>> 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function intervalMs(interval: string): number {
  const n = Number.parseInt(interval, 10);
  if (!Number.isFinite(n) || n <= 0) return 60_000;
  const unit = interval.replace(/^\d+/, "");
  if (unit === "s") return n * 1_000;
  if (unit === "d") return n * 86_400_000;
  if (unit === "h") return n * 3_600_000;
  if (unit === "w") return n * 604_800_000;
  return n * 60_000;
}

interface Component {
  amp: number;
  freq: number;
  phase: number;
}

/**
 * 快频谱分量：不同种子 → 不同相位 → 不同走势。
 *
 * 振幅取 w·period/(2π)，于是每个分量对"单根 K 线变动"的方差相同
 * （Σw²/2 = 1 → 单根变动标准差恰好 1 个单位，再乘 vol 得到实际波动率），
 * 8 个随机相位叠加后单根涨跌近似正态。
 *
 * 频带上界故意只到 80 根：分量周期一旦远长于回放窗口，它在窗口内就退化成
 * 一段恒定漂移（增量的方差集中在单侧），价格会被推到天上/地下。
 * 长周期的"趋势"交给单独的慢趋势项，那里用绝对幅度限幅，行为可预期。
 */
const fastCache = new Map<string, Component[]>();

function fastSpectrumOf(seed: number, tag: string): Component[] {
  const key = `${seed}|${tag}`;
  const hit = fastCache.get(key);
  if (hit) return hit;
  const w = Math.sqrt(2 / FAST_COMPONENTS);
  const comps: Component[] = [];
  for (let k = 0; k < FAST_COMPONENTS; k += 1) {
    const period = FAST_MIN_PERIOD * FAST_RATIO ** k;
    comps.push({
      amp: ((w / (2 * Math.PI)) * period),
      freq: 1 / period,
      phase: randOf(seed, tag, k, "phase") * 2 * Math.PI,
    });
  }
  if (fastCache.size > 500) fastCache.clear();
  fastCache.set(key, comps);
  return comps;
}

/** 快游走值（单位：1 = 该周期的标准差，由 vol 换算成百分比）。 */
function fastWalkOf(seed: number, tag: string, i: number): number {
  let sum = 0;
  for (const c of fastSpectrumOf(seed, tag)) {
    sum += c.amp * Math.sin(2 * Math.PI * c.freq * i + c.phase);
  }
  return sum;
}

/**
 * 慢趋势值 ∈ [-1, 1]：一个长周期正弦，相位随种子变化。
 *
 * 它决定"这段行情是上行、下行还是横盘"，幅度由调用方按品种限幅，
 * 所以无论走多少根 K 线，价格都落在可解释的区间里。
 */
function slowWalkOf(seed: number, tag: string, i: number): number {
  return Math.sin((2 * Math.PI * i) / SLOW_PERIOD + randOf(seed, tag, "slow-phase") * 2 * Math.PI);
}

/** 各标的的行情特征：起始价、日波动率、β、慢趋势幅度。 */
function profileOf(symbol: string, barsPerDay: number): {
  anchor: number;
  /** 单根 K 线波动率（已按周期折算） */
  vol: number;
  beta: number;
  slowAmp: number;
} {
  const h = hashOf(symbol);
  const isCrypto = /BTC|ETH|USDT|SOL/i.test(symbol);
  // 日波动率：加密比股票大 2 倍左右
  const dailyVol = isCrypto ? 0.025 : 0.012;
  return {
    anchor: isCrypto ? 3000 + (h % 60000) / 10 : 20 + (h % 48000) / 10,
    // 折算到单根：日波动率 ÷ √(每日根数)，所以 1m 与 1d 反映的是同一种波动性
    vol: dailyVol / Math.sqrt(Math.max(1, barsPerDay)),
    // β ∈ [0.5, 1.5]：同涨同跌但不相同 —— 横截面配置类策略才能被正确考察
    beta: 0.5 + ((h >>> 7) % 1000) / 1000,
    // 慢趋势幅度（日志空间）：把长期涨跌限制在可解释的区间内，价格不会离谱
    slowAmp: isCrypto ? 0.45 : 0.25,
  };
}

export class SimulatedAdapter implements ExchangeAdapter {
  readonly meta: AdapterMeta = {
    id: "simulated",
    name: "模拟交易所",
    assetClass: "mixed",
    description:
      "本地随机行情：每次回测/对照都掷一条新的随机路径，用来观察策略在不可预测行情下的表现。结果带情景种子，需要复现时可原样重跑。",
    requiresKeys: false,
    supportsTrading: true,
    supportsTestnet: false,
    klineIntervals: ["1s", "5s", "15s", "30s", "1m", "5m", "15m", "1h", "4h", "1d"],
    keyFields: [],
    defaultSymbols: DEMO_SYMBOLS,
    notes: [
      "无需密钥",
      "每次历史模拟都掷一条新的随机路径（同一根 K 线不会每回都长一样）",
      "同一情景内取数自洽：同一时刻反复取必得同一根 K 线",
      "结果里带情景种子，想复现某次结果就用同一个种子重跑（配合同一时刻）",
      "K 线按周期整点生成：实时机器人连这里时，1m 周期就是每分钟一根，与真实行情一致",
      "提供秒级周期（1s/5s/15s/30s）：干跑时能按秒看到决策，仍然是真实时间节奏，没有加速",
    ],
  };

  private scenarioSeed: number;
  /** 环境变量锁定的种子（用于测试/复现），没设就是每次随机。 */
  private readonly fixedSeed: number | null;
  /** 锁定的"现在"（epoch ms），没设就用真实时钟。 */
  private readonly pinnedNow: number | null;

  constructor() {
    const seedText = readEnv("SIM_SEED");
    const parsed = seedText ? Number(seedText) : Number.NaN;
    this.fixedSeed = Number.isFinite(parsed) ? parsed >>> 0 : null;
    this.scenarioSeed = this.fixedSeed ?? (Math.floor(Math.random() * 0xffffffff) >>> 0);
    const nowText = readEnv("SIM_NOW");
    const nowRaw = nowText ? Number(nowText) : Number.NaN;
    this.pinnedNow = Number.isFinite(nowRaw) ? Math.floor(nowRaw) : null;
  }

  /**
   * 模拟世界的"现在"。
   *
   * 路径是时间的函数，所以复现一条路径要连时刻一起复现：
   * 只锁种子不锁时刻，取到的仍是"那一刻往前数 120 分钟"，换个钟点窗口就平移了。
   * 测试与复现核对都靠这个（环境变量 SIM_NOW，epoch 毫秒）。
   */
  private now(): number {
    return this.pinnedNow ?? Date.now();
  }

  /** 当前情景种子（记进结果，便于复现）。 */
  get seed(): number {
    return this.scenarioSeed;
  }

  /**
   * 换一个情景：之后取到的将是**另一条**随机路径。
   *
   * 谁调用它，决定了「公平」怎么定义：
   * - 历史模拟每次调用 → 每次都是一次新的考验，能看出策略稳不稳；
   * - 模拟对照**只调用一次** → 所有参赛者面对同一条路径，否则比分没有意义；
   * - 实时机器人不调用 → 轮询看到的是同一条路径在延伸。
   */
  newScenario(seed?: number): number {
    this.scenarioSeed = (seed ?? this.fixedSeed ?? Math.floor(Math.random() * 0xffffffff)) >>> 0;
    return this.scenarioSeed;
  }

  init(_cred: Credential): void {
    /* 无需初始化 */
  }

  async testConnection(): Promise<ConnectionTest> {
    return { ok: true, message: `模拟交易所始终可用（本地随机行情，当前情景种子 ${this.scenarioSeed}）` };
  }

  async searchSymbols(query: string, limit = 20): Promise<SymbolInfo[]> {
    const q = query.trim().toUpperCase();
    if (!q) return DEMO_SYMBOLS.slice(0, limit);
    return DEMO_SYMBOLS.filter(
      (s) => s.symbol.toUpperCase().includes(q) || s.name.includes(query.trim()),
    ).slice(0, limit);
  }

  /** 第 i 步的收盘价。市场因子所有标的共享 → 存在横截面相关性。 */
  private closeAt(symbol: string, stepMs: number, ts: number): number {
    const p = profileOf(symbol, 86_400_000 / stepMs);
    const i = ts / stepMs;
    // 快段：逐根波动。除以 √(β²+1) 是为了让 profile.vol 就是这个标的的
    // 实际日波动率（否则 β 大的标的会偷偷更颠簸）
    const betaNorm = p.beta / Math.sqrt(p.beta * p.beta + 1);
    const fastMarket = fastWalkOf(this.scenarioSeed, "market", i);
    const fastIdio = fastWalkOf(this.scenarioSeed, `s:${symbol}`, i);
    // 慢段：行情风格（上行/下行/横盘），幅度有界
    const slowMarket = slowWalkOf(this.scenarioSeed, "market-slow", i);
    const slowIdio = slowWalkOf(this.scenarioSeed, `s:${symbol}-slow`, i);
    const logRet =
      p.vol * (betaNorm * fastMarket + fastIdio / Math.sqrt(2)) +
      p.slowAmp * ((p.beta / 1.5) * slowMarket + 0.5 * slowIdio);
    return Math.max(0.01, p.anchor * Math.exp(logRet));
  }

  /** 最近 limit 根，时间升序。生成到"此刻"为止，不多一根。 */
  async fetchKlines(symbol: string, interval: string, limit: number): Promise<Bar[]> {
    const step = intervalMs(interval);
    const lastTs = Math.floor(this.now() / step) * step;
    const bars: Bar[] = [];
    for (let i = limit; i >= 1; i -= 1) {
      const ts = lastTs - (i - 1) * step;
      const close = this.closeAt(symbol, step, ts);
      const open = this.closeAt(symbol, step, ts - step);
      const up = randOf(this.scenarioSeed, symbol, ts, "hi");
      const down = randOf(this.scenarioSeed, symbol, ts, "lo");
      bars.push({
        symbol,
        timestamp: new Date(ts),
        open: r4(open),
        high: r4(Math.max(open, close) * (1 + up * 0.004)),
        low: r4(Math.min(open, close) * (1 - down * 0.004)),
        close: r4(close),
        volume: r2(500_000 + randOf(this.scenarioSeed, symbol, ts, "vol") * 500_000),
      });
    }
    return bars;
  }

  async fetchTickers(symbols: string[]): Promise<Ticker[]> {
    const step = intervalMs("1m");
    const ts = Math.floor(this.now() / step) * step;
    return symbols.map((symbol) => {
      const price = this.closeAt(symbol, step, ts);
      const prev = this.closeAt(symbol, step, ts - step);
      return { symbol, price, changePct: prev > 0 ? (price / prev - 1) * 100 : 0, volume: 1_000_000, timestamp: ts };
    });
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const step = intervalMs("1m");
    const price = this.closeAt(req.symbol, step, Math.floor(this.now() / step) * step);
    const qty = req.quoteQty && !req.quantity ? req.quoteQty / price : (req.quantity ?? 0);
    if (!(qty > 0)) {
      return { orderId: "", status: "rejected", filledQty: 0, avgPrice: 0, fee: 0, message: "数量必须为正" };
    }
    const fee = price * qty * 0.001;
    return {
      orderId: `SIM-${Date.now()}`,
      status: "filled",
      filledQty: qty,
      avgPrice: price,
      fee,
      message: "模拟成交",
    };
  }
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}
function r4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

export type { Side };