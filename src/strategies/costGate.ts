/**
 * 成本感知信号闸门：把「这次信号值不值得花一笔手续费」做进策略层。
 *
 * 为什么需要它：策略原先完全不知道交易成本的存在。实测数据（1m 机器人
 * 60 笔成交：已实现盈亏 −539，其中费用 267）表明亏损主因不是方向全错，
 * 而是**噪声换手被成本碾轧**——2/8 双均线在 1m 上每 1~4 分钟翻转一次，
 * 单次往返成本 ≈ 2×(taker 费 + 滑点) ≈ 26bps，而信号捕捉的移动平均
 * 只有 3~8bps，每笔期望为负，成交越多亏得越确定。
 *
 * 三道闸（对齐开源执行框架的成本过滤惯例）：
 * 1. **最小变动收益**：新仓位的预期趋势移动至少要盖过 K 倍往返成本，
 *    否则不值得动手——这就是把「手续费门槛」翻译成策略语言；
 * 2. **冷却期**：刚平仓后在 cooldownBars 根内不许再进场（含翻仓），
 *    防止在迟滞带边缘反复进出；
 * 3. **翻仓不拦截**（拦截交给引擎的迟滞）：多→空直接一步走。
 *
 * 它是 Strategy 装饰器：包住任意引擎（momentum/adaptive/breakout/meanrev/
 * custom），不侵入各引擎内部逻辑；引擎照常算信号，闸门决定放行/拦截。
 */

import type { Signal } from "../core/types.js";
import { getLogger } from "../core/logger.js";
import type { Strategy, StrategyContext } from "./strategy.js";
import { noiseScale } from "./momentum.js";

const log = getLogger("strategy:costgate");

export interface CostGateOptions {
  /** 单边成本（小数）：taker 费 + 平均滑点。例：0.0003 + 0.0002 = 0.0005 */
  oneWayCost: number;
  /**
   * 预期趋势移动至少要盖过几倍往返成本（默认 3）。
   * 往返 = 2 × oneWayCost。K=3 的语义：预计赚的钱得先够付 3 次来回，
   * 剩下的才是自己的——保守，但比「方向对一点就动手」诚实得多。
   */
  costCoverage?: number;
  /**
   * 预期持有根数（把趋势斜率折算到持有期视野）。
   * 缺省 = slow（策略自己的慢线窗口）：2/8 仍是 8 根，16/48 自动用 48 根。
   * 曾经写死 8 根，窗口调长后趋势斜率被除得越来越小 —— 16/48 要 3.36%
   * 的均线差才能过闸，5m 上等于永不交易（v2 预设就是这么被静默废掉的）。
   */
  holdHorizonBars?: number;
  /** 平仓后再进场的冷却根数（默认 6） */
  cooldownBars?: number;
  /** 快慢窗口（趋势斜率估计用；与被包装策略一致） */
  fast?: number;
  slow?: number;
}

export class CostAwareGate implements Strategy {
  readonly name: string;

  /** symbol -> 最近一次离场时的 K 线序号（进场/离场按信号 targetWeight 变化判定） */
  private readonly lastExit = new Map<string, number>();
  /** symbol -> 当前持仓方向（+1/−1/0），由信号流推断 */
  private readonly dir = new Map<string, number>();
  private readonly barSeq = new Map<string, number>();

  constructor(
    private readonly inner: Strategy,
    private readonly opts: CostGateOptions,
  ) {
    this.name = `costgate(${inner.name})`;
  }

  get warmup(): number {
    return this.inner.warmup;
  }

  async generate(ctx: StrategyContext): Promise<Signal | null> {
    const seq = (this.barSeq.get(ctx.symbol) ?? 0) + 1;
    this.barSeq.set(ctx.symbol, seq);

    const raw = await this.inner.generate(ctx);
    if (!raw) return null;

    const prevDir = this.dir.get(ctx.symbol) ?? 0;
    const newDir = Math.sign(raw.targetWeight);

    // 平仓（→0）：放行并记账。冷却期从这一刻起算。
    if (newDir === 0 && prevDir !== 0) {
      this.lastExit.set(ctx.symbol, seq);
      this.dir.set(ctx.symbol, 0);
      return raw;
    }

    // 无仓位变化（同方向持有中引擎重复发同向信号）：透传，风控死区会吸收微调
    if (newDir !== 0 && newDir === prevDir) {
      return raw;
    }

    // 进场 / 翻仓（0→±1 或 +1→−1）：过两道闸
    const cooldown = this.opts.cooldownBars ?? 6;
    const exitedAt = this.lastExit.get(ctx.symbol);
    if (exitedAt !== undefined && seq - exitedAt < cooldown) {
      log.debug("%s 冷却期内（第 %d/<%d 根），拦截进场", ctx.symbol, seq - exitedAt, cooldown);
      return null;
    }

    const bars = ctx.bars;
    if (bars.length >= 3) {
      const fast = this.opts.fast ?? 2;
      const slow = this.opts.slow ?? 8;
      // 持有视野跟策略窗口走：慢线越长，进场后本来就该拿得越久。
      const horizon = this.opts.holdHorizonBars ?? slow;
      /*
       * 趋势移动估计（对齐 momentum 引擎的噪声归一口径，MLE 线性外推）：
       * |fastMa − slowMa| 是最近 (slow−fast)/2 根内积累的趋势量（快线滞后
       * fast/2、慢线滞后 slow/2），把它除以积累窗口得到**每根斜率**，持有
       * horizon 根的预期移动 = 斜率 × horizon。不用 √H 外推——那是随机游走
       * 的持续性假设，会把噪声「趋势」也按比例延续下去，高估期望收益。
       * 噪声行情里 z 超过引擎进场带（1.5）的概率本就有 ~12%，靠 z 本身
       * 分不开信号与噪声；把「移动盖不过成本」的进场拦掉，剩下的才是
       * 期望为正的交易。
       */
      const sigma = retSigma(bars, slow);
      if (sigma > 0) {
        const pair = maPair(bars, fast, slow);
        if (pair) {
          const gapRatio = Math.abs(pair.fast - pair.slow) / pair.slow;
          /*
           * 保守外推：MA 差是最近 (slow−fast) 根内积累的趋势量（滞后差），
           * 持有 horizon 根的移动按**同斜率延续**估计 = gap × horizon/(slow−fast)。
           * 不除以 (slow−fast)/2——那是滞后差的精确展开，在「进场时点」
           * 有严重选择偏差：引擎只在 z 超带时进场，这些时点的 gap 天然是
           * 噪声分布的极值（纯噪声下 p90 也到 20+bps），按极值线性外推
           * 等于把「运气最好的一段噪声」当成可持续斜率，几乎笔笔放行。
           * 用全窗口积累 (slow−fast) 折算 + 持续性折扣 0.5（均值回归
           * 让实测趋势半衰期短于线性假设），只有真正大幅的趋势才过闸。
           */
          const trendMove = (gapRatio / (slow - fast)) * horizon * 0.5;
          const minMove = (this.opts.costCoverage ?? 3) * 2 * this.opts.oneWayCost;
          if (trendMove < minMove) {
            const noise = sigma * noiseScale(fast, slow);
            const z = gapRatio / noise;
            log.debug(
              "%s 预期移动 %.1f bps < 门槛 %.1f bps（z=%.2f，%d×往返成本），拦截进场",
              ctx.symbol,
              trendMove * 1e4,
              minMove * 1e4,
              z,
              this.opts.costCoverage ?? 3,
            );
            return null;
          }
        }
      }
    }

    this.dir.set(ctx.symbol, newDir);
    return raw;
  }
}

/** 最近 n 根对数收益的标准差（σ：单根噪声尺度）。 */
export function retSigma(bars: { close: number }[], n: number): number {
  const closes = bars.slice(-(n + 1)).map((b) => b.close).filter((c) => c > 0);
  if (closes.length < 2) return 0;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const r = Math.log(closes[i]! / closes[i - 1]!);
    if (Number.isFinite(r)) rets.push(r);
  }
  if (rets.length < 2) return 0;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const ss = rets.reduce((acc, r) => acc + (r - m) * (r - m), 0);
  return Math.sqrt(ss / (rets.length - 1));
}

/** 快慢均线对（数据不足返回 null，闸门退化为只靠冷却期）。 */
function maPair(bars: { close: number }[], fast: number, slow: number): { fast: number; slow: number } | null {
  const closes = bars.slice(-slow).map((b) => b.close);
  if (closes.length < slow) return null;
  const fastMa = closes.slice(-fast).reduce((a, b) => a + b, 0) / Math.min(fast, closes.length);
  const slowMa = closes.reduce((a, b) => a + b, 0) / closes.length;
  return { fast: fastMa, slow: slowMa };
}
