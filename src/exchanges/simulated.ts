/**
 * 模拟交易所：本地生成的行情走向 + 模拟成交。
 *
 * 它跟任何真实市场无关，**没有标的**：这里的每一个"交易物"就是一条**行情走向**
 * （单边上行 / 缓慢阴跌 / 震荡整理 / 急速跳水 / 急涨急跌）。存在的理由只有一个：
 * 让策略在同一轮里同时面对几种截然不同的市场情况，看它到底是"会做趋势"还是
 * "只会顺着一段行情赚钱"。
 *
 * 走向的形状是定的，噪声是掷的 —— 两者都写成"纯函数"：
 * 1. **情景内自洽**：价格是 (情景种子, 走向名, 时刻) 的纯函数，不依赖取数顺序。
 *    同一窗口反复取结果逐字节一致，实时轮询不会自己改写历史，历史模拟的
 *    预热段和后续成交必然对得上。
 * 2. **随时间向前**：K 线只往后长。行情永远"生成到此刻为止"，没有任何一根
 *    K 线能用到的信息出现在它之前。
 * 3. **可按需复现**：情景带种子并记进结果。想复现某次随机结果就把种子填回去
 *    （环境变量 SIM_SEED / SIM_NOW，或接口参数 scenarioSeed），默认每次都是新的噪声。
 *
 * 走向的"形状"本身不掷随机：不然"急速跳水"有时会变成"急速跳水之后再跳水"，
 * 测的就不再是那条走向了。随机的是叠加在上面的快噪声。
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

/**
 * 一条行情走向。模拟交易所的"交易物"就是它 —— 没有品种代码，
 * 用走向名当键（策略要按横截面分配权重，总得有个东西承载仓位）。
 */
interface Regime {
  /** 走向名，也是它在行情/持仓/成交里的键 */
  symbol: string;
  /** 一句话说明这条走向长什么样（界面直接展示） */
  name: string;
  /** 起始价位 */
  anchor: number;
  /** 波动率倍数（相对基准日波动率） */
  volMult: number;
  /**
   * 特征位置 u∈[0,1)：把"情景创建的那一刻"放在这里，于是它前面的取数窗口
   * 正好是这条走向该有的样子（窗口是往回看的，最后一根落在 at）。
   */
  at: number;
  /** 形状：周期位置 u → 对数价格偏移。必须在 u 上周期连续、有界。 */
  shape: (u: number) => number;
}

/** 基准日波动率：走向按加密级别给波动（框架里最颠的一档，方便看出策略差别）。 */
const BASE_DAILY_VOL = 0.025;
/**
 * 走向周期：一个完整循环 600 根 K 线。
 *
 * 不能太短：窗口（几百根以内）要只占其中一段，否则一条走向在一个窗口里
 * 自我抵消，看起来就只是噪声。也不能太长：形状在窗口内会退化成一段恒定漂移。
 */
const CYCLE_BARS = 600;

const TAU = Math.PI * 2;

const frac = (v: number): number => v - Math.floor(v);

/** 周期距离 ∈ [0, 0.5]：把 u 与 c 的距离折回一个周期内。 */
function cycleDist(u: number, c: number): number {
  return Math.abs(frac(u - c + 0.5) - 0.5);
}

/** 周期脉冲：中心 c 处为 1，离开 c 按高斯衰减（宽度 w），周期连续、有界。 */
function bump(u: number, c: number, w: number): number {
  const d = cycleDist(u, c);
  return Math.exp(-((d / w) ** 2));
}

/**
 * 走向表。每条都取周期中的一小段当"特征段"，相位由 at 锚定。
 *
 * 形状是 bar 空间里的固定曲线（周期 600 根），所以 1m 与 1d 看到的是同一种形状，
 * 只是叠加的噪声不同。把噪声平均掉之后，一个 120 根的窗口大致长这样：
 * 单边上行收高约 20%、缓慢阴跌收低约 15%、震荡整理净变化≈0 而中途来回 20% 上下、
 * 急速跳水收低约 40%、急涨急跌先冲高 30% 上下再落回起点之下。
 * 量级留在可解释的区间里，不会把价格推到天上/地下；判据在 test/scenario.test.ts
 * 的「走向」用例里 —— 改这里的形状，必须连那条用例一起改。
 */
const REGIMES: Regime[] = [
  {
    symbol: "单边上行",
    name: "稳步抬升的上涨行情",
    anchor: 1200,
    volMult: 0.9,
    at: 0.06,
    // 前一段还在谷底，窗口内一路向上，到"此刻"仍在爬坡（斜率不为 0）
    shape: (u) => 0.2 * Math.sin(TAU * u),
  },
  {
    symbol: "缓慢阴跌",
    name: "小步下滑的阴跌行情",
    anchor: 2400,
    volMult: 0.8,
    at: 0.06,
    shape: (u) => -0.15 * Math.sin(TAU * u),
  },
  {
    symbol: "震荡整理",
    name: "区间来回的横盘行情",
    anchor: 800,
    volMult: 1.0,
    at: 0.22,
    // 频率 ×6：一个窗口里来回两趟，方向反复
    shape: (u) => 0.15 * Math.sin(TAU * 6 * u),
  },
  {
    symbol: "急速跳水",
    name: "横盘后急速下跌的恐慌行情",
    anchor: 3600,
    volMult: 1.3,
    at: 0.93,
    // 中心就在"此刻"：窗口前半段平，最后一段急跌到底
    shape: (u) => -0.45 * bump(u, 0.93, 0.1),
  },
  {
    symbol: "急涨急跌",
    name: "先急涨再急跌的甩人行情",
    anchor: 1600,
    volMult: 1.4,
    at: 0.945,
    // 一根上冲脉冲接着一根下砸脉冲：追进去就被甩
    shape: (u) => 0.35 * bump(u, 0.86, 0.06) - 0.35 * bump(u, 0.965, 0.06),
  },
];

const DEFAULT_REGIME = REGIMES[0]!;

/** 走向对应的 SymbolInfo（界面上的"标的"就是这些走向名）。 */
const SANDBOX_SYMBOLS: SymbolInfo[] = REGIMES.map((r) => ({
  symbol: r.symbol,
  name: r.name,
  // 走向不是真实品种，没有资产类别可谈；按加密给波动，取它最颠的一档
  assetClass: "crypto",
  currency: "USDT",
  lotSize: 1,
  pricePrecision: 2,
  qtyPrecision: 6,
}));

/** 随机游走的快频带：周期从 4 根到 80 根（几何分布）。 */
const FAST_MIN_PERIOD = 4;
const FAST_MAX_PERIOD = 80;
const FAST_COMPONENTS = 8;

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
 * 长周期的"走向"交给各条走向自己的 shape，那里用绝对幅度限幅，行为可预期。
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
    sum += c.amp * Math.sin(TAU * c.freq * i + c.phase);
  }
  return sum;
}

/**
 * 走向查找。
 *
 * 表里没有的代码（测试与调试会随便传，"600519""BTC"都算）一律走默认走向，
 * 免得某个随机选中的阴跌走向让"等成交"的用例永远等不到 —— 那是用例在赌运气。
 */
function regimeOf(symbol: string): Regime {
  return REGIMES.find((r) => r.symbol === symbol) ?? DEFAULT_REGIME;
}

/** β ∈ [0.5, 1.5]：各走向的短噪声共享一个市场因子，同涨同跌但不相同。 */
function betaOf(symbol: string): number {
  return 0.5 + ((hashOf(symbol) >>> 7) % 1000) / 1000;
}

/** 单根 K 线的噪声标准差：日波动率 ÷ √(每日根数)，1m 与 1d 反映同一种波动性。 */
function volPerBar(stepMs: number, volMult: number): number {
  const barsPerDay = 86_400_000 / stepMs;
  return (BASE_DAILY_VOL / Math.sqrt(Math.max(1, barsPerDay))) * volMult;
}

export class SimulatedAdapter implements ExchangeAdapter {
  readonly meta: AdapterMeta = {
    id: "simulated",
    name: "模拟交易所",
    assetClass: "mixed",
    description:
      "本地生成行情：五种走向往上叠随机噪声，用来观察策略在不同市场情况下的表现。结果带情景种子，需要复现噪声时可原样重跑。",
    requiresKeys: false,
    supportsTrading: true,
    supportsTestnet: false,
    klineIntervals: ["1s", "5s", "15s", "30s", "1m", "5m", "15m", "1h", "4h", "1d"],
    keyFields: [],
    defaultSymbols: SANDBOX_SYMBOLS,
    // 交易什么由交易所自己定：候选池里没有它要配置的东西
    builtinSymbols: true,
    notes: [
      "无需密钥",
      "没有标的：交易物是几条本地走向（单边上行 / 缓慢阴跌 / 震荡整理 / 急速跳水 / 急涨急跌），形状在本地生成、噪声随机",
      "不用在候选池里挑：这个交易所没有「允许交易哪些标的」这回事",
      "走向的形状是固定的：单边上行就一路上行，急速跳水就横盘后急跌 —— 想比对的是策略在不同走向下的盈利",
      "形状之上叠的是随机噪声：每次历史模拟都掷一条新的噪声，同一根 K 线不会每回都长一样",
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
  /** 情景创建的那一刻：走向的相位从这里锚定，保证窗口落在特征段上。 */
  private anchorTs: number;
  /** 各周期的锚定根序号（懒算并缓存，同一情景内固定）。 */
  private readonly anchorIndexCache = new Map<number, number>();

  constructor() {
    const seedText = readEnv("SIM_SEED");
    const parsed = seedText ? Number(seedText) : Number.NaN;
    this.fixedSeed = Number.isFinite(parsed) ? parsed >>> 0 : null;
    this.scenarioSeed = this.fixedSeed ?? (Math.floor(Math.random() * 0xffffffff) >>> 0);
    const nowText = readEnv("SIM_NOW");
    const nowRaw = nowText ? Number(nowText) : Number.NaN;
    this.pinnedNow = Number.isFinite(nowRaw) ? Math.floor(nowRaw) : null;
    this.anchorTs = this.now();
  }

  /**
   * 模拟世界的"现在"。
   *
   * 路径是时间的函数，所以复现一条路径要连时刻一起复现：只锁种子不锁时刻，
   * 取到的仍是"那一刻往回数的窗口"，换个钟点窗口就平移了。
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
   * 换一个情景：之后取到的将是**另一条**行情（走向形状不变，噪声重掷）。
   *
   * 谁调用它，决定了「公平」怎么定义：
   * - 历史模拟每次调用 → 每次都是一次新的考验，能看出策略稳不稳；
   * - 模拟对照**只调用一次** → 所有参赛者面对同一条行情，否则比分没有意义；
   * - 实时机器人不调用 → 轮询看到的是同一条行情在延伸。
   */
  newScenario(seed?: number): number {
    this.scenarioSeed = (seed ?? this.fixedSeed ?? Math.floor(Math.random() * 0xffffffff)) >>> 0;
    this.anchorTs = this.now();
    this.anchorIndexCache.clear();
    return this.scenarioSeed;
  }

  init(_cred: Credential): void {
    /* 无需初始化 */
  }

  async testConnection(): Promise<ConnectionTest> {
    return { ok: true, message: `模拟交易所始终可用（本地生成行情，当前情景种子 ${this.scenarioSeed}）` };
  }

  async searchSymbols(query: string, limit = 20): Promise<SymbolInfo[]> {
    const q = query.trim().toUpperCase();
    if (!q) return SANDBOX_SYMBOLS.slice(0, limit);
    return SANDBOX_SYMBOLS.filter(
      (s) => s.symbol.toUpperCase().includes(q) || s.name.includes(query.trim()),
    ).slice(0, limit);
  }

  /**
   * 该周期上"情景创建那一刻"的根序号。
   *
   * 懒算并缓存：相位要在同一情景内固定，不能在每次取数时重新按当前钟点算 ——
   * 那等于窗口每取一次就平移一次，历史会被自己改写。
   */
  private anchorIndex(stepMs: number): number {
    let i0 = this.anchorIndexCache.get(stepMs);
    if (i0 === undefined) {
      i0 = Math.floor(this.anchorTs / stepMs);
      this.anchorIndexCache.set(stepMs, i0);
    }
    return i0;
  }

  /** 第 i 步的收盘价：走向形状 + 共享市场的快噪声。 */
  private closeAt(symbol: string, stepMs: number, ts: number): number {
    const r = regimeOf(symbol);
    const i = ts / stepMs;
    // 周期位置：情景创建那一刻落在 r.at，于是往前的窗口正好是这条走向的样子
    const u = frac((i - this.anchorIndex(stepMs)) / CYCLE_BARS + r.at);
    const vol = volPerBar(stepMs, r.volMult);
    // 除以 √(β²+1) 是为了让 vol 就是这个走向的实际波动率（否则 β 大的走向会偷偷更颠簸）
    const beta = betaOf(symbol);
    const betaNorm = beta / Math.sqrt(beta * beta + 1);
    const fastMarket = fastWalkOf(this.scenarioSeed, "market", i);
    const fastIdio = fastWalkOf(this.scenarioSeed, `s:${symbol}`, i);
    const logRet = r.shape(u) + vol * (betaNorm * fastMarket + fastIdio / Math.SQRT2);
    return Math.max(0.01, r.anchor * Math.exp(logRet));
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
