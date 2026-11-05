/**
 * 自定义策略沙箱 worker（线程入口）。
 *
 * 收主线程的执行请求：node:vm 隔离执行用户代码（断 require/process/网络），
 * vm 层 timeout 只是第二道防线（部分 Node 版本不可靠），真正的硬杀在主线程
 * terminate 本线程。
 *
 * 注意：这个文件被打包为独立产物（tsconfig 会把 src/**.ts 编译到 dist/**.js），
 * Worker 路径由 customSandbox.ts 解析。
 */

import { parentPort } from "node:worker_threads";
import { createContext, Script, type Context } from "node:vm";
import type { SandboxRequest, SandboxResponse } from "./customSandbox.js";

if (!parentPort) throw new Error("本文件只能作为 worker 线程入口运行");
const port = parentPort;

/** 缓存已编译的用户代码：同一策略每根 K 线都要执行，编译一次。 */
const compiled = new Map<string, { script: Script; ctx: Context }>();

function compile(code: string): { script: Script; ctx: Context } {
  const hit = compiled.get(code);
  if (hit) return hit;
  // 沙箱全局：只有注入的 helpers 与 log；Math/JSON 等标准内建由 createContext 补齐。
  // 故意不给 console / require / process / fetch / setTimeout。
  const ctx = createContext({
    helpers: makeHelpers(),
    log: (...args: unknown[]) => {
      // 日志转主线程（id=-1 的日志通道，主线程转 logger）
      port.postMessage({ id: -1, ok: true, logText: args.map(String).join(" ") } as unknown as SandboxResponse);
    },
  });
  const script = new Script(`(function(bars, state, asset, helpers, log) {\n${code}\n})`, {
    filename: "strategy.user.js",
  });
  const entry = { script, ctx };
  // 缓存上限防内存涨爆（每个不同代码一份编译产物）
  if (compiled.size > 16) compiled.delete(compiled.keys().next().value!);
  compiled.set(code, entry);
  return entry;
}

port.on("message", (req: SandboxRequest) => {
  try {
    const { script, ctx } = compile(req.code);
    // state 传入执行前的副本，用户在函数里对它原地修改；
    // 函数返回后把 ctx 里被改过的 state 克隆回主线程。
    const fn = script.runInContext(ctx, { timeout: req.timeoutMs }) as (
      bars: unknown,
      state: unknown,
      asset: string,
      helpers: unknown,
      log: (...a: unknown[]) => void,
    ) => unknown;
    const value = fn(req.bars, req.state, req.symbol, ctx.helpers, (...a: unknown[]) => {
      port.postMessage({ id: -1, ok: true, logText: a.map(String).join(" ") } as unknown as SandboxResponse);
    });
    const out: SandboxResponse = { id: req.id, ok: true, value, state: req.state };
    port.postMessage(out);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    const out: SandboxResponse = { id: req.id, ok: false, error: msg };
    port.postMessage(out);
  }
});

// ---------------- helpers（与 customStrategy.ts 同一套语义） ----------------

function finiteOr0(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function tail(arr: number[], n?: unknown): number[] {
  if (n === undefined) return arr;
  const k = Math.floor(finiteOr0(n));
  if (k <= 0) return [];
  return k >= arr.length ? arr : arr.slice(arr.length - k);
}

function closes(bars: unknown): number[] {
  return (Array.isArray(bars) ? bars : []).map((b) => finiteOr0((b as { close?: number })?.close));
}

function smaImpl(bars: unknown, period: unknown, outLen?: unknown): number[] {
  const c = closes(bars);
  const p = Math.max(1, Math.floor(finiteOr0(period)));
  if (c.length < p) return [];
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < c.length; i++) {
    sum += c[i]!;
    if (i >= p) sum -= c[i - p]!;
    if (i >= p - 1) out.push(sum / p);
  }
  return tail(out, outLen);
}

function emaImpl(bars: unknown, period: unknown, outLen?: unknown): number[] {
  const c = closes(bars);
  const p = Math.max(1, Math.floor(finiteOr0(period)));
  if (c.length < p) return [];
  const k = 2 / (p + 1);
  const out: number[] = [];
  let prev = c.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out.push(prev);
  for (let i = p; i < c.length; i++) {
    prev = c[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return tail(out, outLen);
}

function stddevImpl(bars: unknown, period: unknown, outLen?: unknown): number[] {
  const c = closes(bars);
  const p = Math.max(2, Math.floor(finiteOr0(period)));
  if (c.length < p) return [];
  const out: number[] = [];
  for (let i = p - 1; i < c.length; i++) {
    const win = c.slice(i - p + 1, i + 1);
    const mean = win.reduce((a, b) => a + b, 0) / p;
    out.push(Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / p));
  }
  return tail(out, outLen);
}

function rsiImpl(bars: unknown, period: unknown, outLen?: unknown): number[] {
  const c = closes(bars);
  const p = Math.max(2, Math.floor(finiteOr0(period)));
  if (c.length < p + 1) return [];
  const out: number[] = [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= p; i++) {
    const d = c[i]! - c[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= p;
  loss /= p;
  out.push(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i]! - c[i - 1]!;
    gain = (gain * (p - 1) + Math.max(d, 0)) / p;
    loss = (loss * (p - 1) + Math.max(-d, 0)) / p;
    out.push(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  }
  return tail(out, outLen);
}

function atrImpl(bars: unknown, period: unknown, outLen?: unknown): number[] {
  const list = (Array.isArray(bars) ? bars : []) as { high: number; low: number; close: number }[];
  const p = Math.max(1, Math.floor(finiteOr0(period)));
  if (list.length < p + 1) return [];
  const tr: number[] = [0];
  for (let i = 1; i < list.length; i++) {
    const b = list[i]!;
    const pc = list[i - 1]!.close;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }
  const out: number[] = [];
  let prev = tr.slice(1, p + 1).reduce((a, b) => a + b, 0) / p;
  out.push(prev);
  for (let i = p + 1; i < list.length; i++) {
    prev = (prev * (p - 1) + tr[i]!) / p;
    out.push(prev);
  }
  return tail(out, outLen);
}

function fieldOf(b: unknown, key: string): number {
  return finiteOr0((b as Record<string, unknown>)?.[key]);
}

const FIELDS = ["open", "high", "low", "close", "volume"];

function highestImpl(bars: unknown, period: unknown, key?: unknown, outLen?: unknown): number[] {
  const list = Array.isArray(bars) ? bars : [];
  const p = Math.max(1, Math.floor(finiteOr0(period)));
  const field = typeof key === "string" && FIELDS.includes(key) ? key : "high";
  if (list.length < p) return [];
  const out: number[] = [];
  for (let i = p - 1; i < list.length; i++) {
    let m = -Infinity;
    for (let j = i - p + 1; j <= i; j++) m = Math.max(m, fieldOf(list[j], field));
    out.push(m);
  }
  return tail(out, outLen);
}

function lowestImpl(bars: unknown, period: unknown, key?: unknown, outLen?: unknown): number[] {
  const list = Array.isArray(bars) ? bars : [];
  const p = Math.max(1, Math.floor(finiteOr0(period)));
  const field = typeof key === "string" && FIELDS.includes(key) ? key : "low";
  if (list.length < p) return [];
  const out: number[] = [];
  for (let i = p - 1; i < list.length; i++) {
    let m = Infinity;
    for (let j = i - p + 1; j <= i; j++) m = Math.min(m, fieldOf(list[j], field));
    out.push(m);
  }
  return tail(out, outLen);
}

function crossoverImpl(a: unknown, b: unknown): boolean {
  const sa = Array.isArray(a) ? a.map(finiteOr0) : null;
  const sb = Array.isArray(b) ? b.map(finiteOr0) : null;
  if (!sa || sa.length < 2) return false;
  const lastB = sb ? sb[sb.length - 1]! : finiteOr0(b);
  const prevB = sb && sb.length >= 2 ? sb[sb.length - 2]! : lastB;
  return sa[sa.length - 1]! > lastB && sa[sa.length - 2]! <= prevB;
}

function crossunderImpl(a: unknown, b: unknown): boolean {
  const sa = Array.isArray(a) ? a.map(finiteOr0) : null;
  const sb = Array.isArray(b) ? b.map(finiteOr0) : null;
  if (!sa || sa.length < 2) return false;
  const lastB = sb ? sb[sb.length - 1]! : finiteOr0(b);
  const prevB = sb && sb.length >= 2 ? sb[sb.length - 2]! : lastB;
  return sa[sa.length - 1]! < lastB && sa[sa.length - 2]! >= prevB;
}

function makeHelpers(): Record<string, (...args: unknown[]) => unknown> {
  return {
    sma: smaImpl,
    ema: emaImpl,
    rsi: rsiImpl,
    stddev: stddevImpl,
    atr: atrImpl,
    highest: highestImpl,
    lowest: lowestImpl,
    crossover: crossoverImpl,
    crossunder: crossunderImpl,
  };
}
