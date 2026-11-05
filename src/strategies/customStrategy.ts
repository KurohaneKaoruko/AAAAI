/**
 * 自定义策略引擎：用户在面板上写一段 JS 函数体，沙箱执行。
 *
 * 安全模型（详见 customSandbox.ts）：
 *   - 用户代码跑在 **worker 线程** + node:vm 双重隔离里：
 *     摸不到 require / process / 网络 / 文件；
 *   - 每根 K 线 50ms 硬超时——worker 被 terminate 硬杀，任何 Node 版本都可靠
 *     （裸 vm 的 timeout 在部分版本上对死循环失效，实测 26.x 掐不住 while(true)）；
 *   - 语法错误在保存策略时就被编译拦下（compileCustomCode），坏代码进不了生产。
 *
 * 用户代码的契约（一段函数体，参数由平台注入）：
 *
 *   // bars    —— 已收盘 K 线，旧→新：{ timestamp, open, high, low, close, volume }
 *   // state   —— 跨 K 线持久状态（每标的独立，首轮 {}，可自由读写；worker 被杀也不丢）
 *   // asset   —— 当前标的代码（如 "ETHUSDT"）
 *   // helpers —— 指标助手：sma / ema / rsi / stddev / atr / highest / lowest / crossover / crossunder
 *   // 返回：0~1 的目标仓位权重（0 = 空仓）；null / undefined = 不动。
 *   //        合约模式允许负数（-1~0 = 做空目标），现货被风控钳到 0。
 *
 *   const fast = helpers.sma(bars, 5);
 *   const slow = helpers.sma(bars, 20);
 *   if (fast.length < 1) return 0;
 *   return fast[fast.length - 1] > slow[slow.length - 1] ? 0.5 : 0;
 *
 * 沙箱里没有 fetch / require / process / console.log（调试用 log()，进机器人日志）。
 */

import type { Bar, Signal } from "../core/types.js";
import type { Strategy, StrategyContext } from "./strategy.js";
import { Script as VmScript } from "node:vm";
import { getLogger } from "../core/logger.js";
import { runInSandbox, sandboxBegin, sandboxEnd } from "./customSandbox.js";
import { CUSTOM_EXEC_TIMEOUT_MS } from "./customTimeout.js";

const log = getLogger("strategy:custom");

export { CUSTOM_EXEC_TIMEOUT_MS };

/** helpers 单次最多处理多少根 K 线（防把事件循环堵死）。 */
export const MAX_LOOKBACK = 5000;

/** reason 字段上限。 */
const MAX_REASON = 120;

/** 数值收尾：非有限数按 0 处理（用户随手 return NaN 不该炸掉整条流水线）。 */
function finiteOr0(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

// ---------------- 编译与校验（主线程侧：保存策略时就拦坏代码） ----------------

/** 编译期静态检查：一眼能看出的危险/荒谬写法直接拒掉（运行时沙箱仍兜底）。 */
export function lintCustomCode(code: string): void {
  if (!code.trim()) throw new Error("策略代码为空：请写一个返回目标仓位（0~1）的函数体");
  if (/\brequire\s*\(/.test(code)) throw new Error("策略代码不能使用 require（沙箱里没有模块系统）");
  if (/\bprocess\b/.test(code)) throw new Error("策略代码不能访问 process（沙箱里没有进程对象）");
  if (/\bimport\s*[(\"]/.test(code)) throw new Error("策略代码不能使用 import（函数体里直接用 helpers）");
  if (/\beval\s*\(|new\s+Function/.test(code)) throw new Error("策略代码不能再套 eval / new Function");
  if (/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/.test(code)) {
    throw new Error("检测到无退出条件的死循环写法（while(true)/for(;;)）——请给出退出条件");
  }
}

/**
 * 编译校验用户代码：语法错误 / 危险写法在这里抛出（保存前就能发现）。
 * 真正的执行在 worker 沙箱里（见 customSandbox.ts），这里只是快筛。
 */
export function compileCustomCode(code: string): { warmup: number } {
  if (!code.trim()) throw new Error("策略代码为空：请写一个返回目标仓位（0~1）的函数体");
  lintCustomCode(code);
  // 语法校验：vm.Script 只编译不执行（安全），语法错误当场抛。
  // 与 worker 里的编译同一包装（函数体 + 相同形参），拦的就是真实会跑的代码。
  new VmScript(`(function(bars, state, asset, helpers, log) {\n${code}\n})`, {
    filename: "strategy.user.js",
  });
  return { warmup: guessWarmup(code) };
}

/** 从代码里猜最小回看窗口：取各指标调用里出现的最大窗口数（sma(bars,20) → 20）。 */
function guessWarmup(code: string): number {
  let max = 0;
  const re = /\b(?:sma|ema|rsi|stddev|atr|highest|lowest)\s*\(\s*[^,()]+,\s*(\d{1,4})\s*(?:,|\))/g;
  for (const m of code.matchAll(re)) max = Math.max(max, Number(m[1]));
  // 指标要窗口根，交叉判断再看一根；留 5 根余量，上限 200（预热太长机器人干等）
  return clamp(Math.ceil(max * 1.2) + 5, 10, 200);
}

// ---------------- 策略类 ----------------

export interface CustomStrategyOptions {
  code: string;
  /** 合约模式：允许负目标（做空）；现货强制钳到 [0,1] */
  allowShort?: boolean;
}

export class CustomStrategy implements Strategy {
  readonly name = "custom";
  readonly warmup: number;
  /** 每标的独立的持久 state（注入用户代码的第二个参数；权威副本在主线程） */
  private readonly states = new Map<string, Record<string, unknown>>();
  /** 每标的独立的执行队列：用户代码有状态，同一标的不允许并发进沙箱 */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: CustomStrategyOptions) {
    // 构造期就编译校验：语法错误当场抛（机器人启动/策略保存时可见）
    compileCustomCode(opts.code);
    this.warmup = guessWarmup(opts.code);
  }

  async generate({ symbol, bars }: StrategyContext): Promise<Signal | null> {
    if (bars.length < this.warmup) return null;
    const last = bars[bars.length - 1]!;
    // 排空计数必须在 generate 的**同步段**递增：enqueue 的 task 要等微任务才跑，
    // 只在 task 里计数的话，回测排空钩子会在那个窗口误判「已空闲」提前喂下一根。
    sandboxBegin();
    try {
      return await this.enqueue(symbol, async () => {
        // 沙箱可见的 bars：ISO 时间字符串、最多 MAX_LOOKBACK 根
        const view = bars.slice(-MAX_LOOKBACK).map((b) => ({
          timestamp: b.timestamp.toISOString(),
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
        }));
        let state = this.states.get(symbol);
        if (!state) {
          state = {};
          this.states.set(symbol, state);
        }
        let out: { value: unknown; state: unknown };
        try {
          out = await runInSandbox({ code: this.opts.code, bars: view, state, symbol });
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          if (msg.includes("超时")) throw err; // 超时错误已经可读
          throw new Error(`策略运行报错: ${msg}`);
        }
        // state 回写：用户代码可能在函数里改了它（跨 K 线状态）
        if (out.state && typeof out.state === "object") {
          this.states.set(symbol, out.state as Record<string, unknown>);
        }
        return this.toSignal(out.value, symbol, last.timestamp);
      });
    } finally {
      sandboxEnd();
    }
  }

  /** 同一标的串行执行：state 是共享可变对象，并发进沙箱会互相踩。 */
  private enqueue<T>(symbol: string, task: () => Promise<T> | T): Promise<T> {
    const prev = this.queues.get(symbol) ?? Promise.resolve();
    const run = prev.then(task, task);
    this.queues.set(
      symbol,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** 返回值收敛成 Signal：数字 | {weight, reason} | null/undefined（不动）。 */
  private toSignal(out: unknown, symbol: string, at: Date): Signal | null {
    if (out === null || out === undefined) return null;
    let weight: number;
    let reason = "custom";
    if (typeof out === "object" && !Array.isArray(out)) {
      const o = out as Record<string, unknown>;
      weight = finiteOr0(o.weight ?? o.target_weight ?? o.targetWeight);
      const r = o.reason ?? o.note;
      if (typeof r === "string" && r.trim()) reason = r.trim().slice(0, MAX_REASON);
    } else {
      weight = finiteOr0(out);
    }
    const min = this.opts.allowShort ? -1 : 0;
    weight = clamp(weight, min, 1);
    return {
      symbol,
      timestamp: at,
      targetWeight: weight,
      // 自定义策略没有置信度概念：给中性 0.5，风控只按目标权重裁决
      confidence: 0.5,
      reason,
    };
  }
}
