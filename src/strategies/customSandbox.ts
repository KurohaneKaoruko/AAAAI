/**
 * 自定义策略沙箱（worker 线程实现）。
 *
 * 为什么不用裸 vm 的 timeout：vm.Script.runInContext 的 timeout 在不同 Node
 * 大版本上行为不一致（26.x 实测连 while(true) 都掐不断），死循环会打穿事件
 * 循环把整台引擎拖死。worker_threads 的 terminate() 是硬杀线程，任何版本都可靠。
 *
 * 结构：
 *   - 全局**单例** worker，所有自定义策略的执行在它里面串行（正常策略单次
 *     执行 <1ms，串行吞吐完全够）；
 *   - worker 冷启动（线程 + 模块加载）约 100~200ms，**不算在用户代码头上**：
 *     50ms 超时计时从 worker online 之后才开始；启动期间的请求排队等待；
 *   - 超时 = terminate() 硬杀 + 所有在途请求失败 + 下次执行时重建（失控是
 *     异常路径，重建成本只发生在死循环时，正常路径零开销）；
 *   - worker 内部仍用 node:vm 隔离（断 require/process/网络），双保险；
 *   - state（用户跨 K 线状态）在主线程持有权威副本，每次执行克隆进 worker、
 *     结束后克隆回来——worker 被杀也不丢状态。
 */

import { Worker } from "node:worker_threads";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getLogger } from "../core/logger.js";
import { CUSTOM_EXEC_TIMEOUT_MS } from "./customTimeout.js";

const log = getLogger("strategy:custom");

/** 单次执行超时（毫秒）。正常策略 <1ms，50ms 已是百倍冗余。 */
export const SANDBOX_TIMEOUT_MS = CUSTOM_EXEC_TIMEOUT_MS;

export interface SandboxRequest {
  /** 请求 id（worker 回包带回） */
  id: number;
  /** 用户策略代码（函数体） */
  code: string;
  /** K 线视图（纯数据，结构化克隆进 worker，不共享内存） */
  bars: unknown;
  /** 用户状态副本（克隆进 worker） */
  state: unknown;
  /** 标的代码 */
  symbol: string;
  /** 沙箱内单次执行超时（vm 层兜底） */
  timeoutMs: number;
}

export interface SandboxResponse {
  id: number;
  ok: boolean;
  /** 用户函数的返回值（结构化克隆后） */
  value?: unknown;
  /** 执行后的用户状态（克隆回来，主线程覆盖保存） */
  state?: unknown;
  /** worker 内 log() 的输出（主线程转 logger） */
  logText?: string;
  error?: string;
}

interface Pending {
  resolve: (r: SandboxResponse) => void;
  timer: NodeJS.Timeout | null;
}

/** worker 源文件路径（与本文件同目录）。 */
const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "customSandboxWorker.js");

/** 当前 worker；null = 尚未启动或已被硬杀，下次执行时重建。 */
let worker: Worker | null = null;
/** worker 是否已完成冷启动（online 事件触发）。 */
let online = false;
/** worker 就绪（online）后的 resolve；spawn 期间暂存，多个请求共享同一个启动过程。 */
let booting: Promise<Worker> | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

/** 拉起 worker（或复用正在启动/已就绪的实例）。 */
function spawn(): Promise<Worker> {
  if (worker && online) return Promise.resolve(worker);
  if (booting) return booting;
  online = false;
  const w = new Worker(WORKER_PATH);
  worker = w;
  booting = new Promise<Worker>((resolve, reject) => {
    // 就绪标准不是 online 事件（ESM 模块懒加载会让首个消息往返再花 100ms+），
    // 而是「ping 往返成功」：探活通过后才把 worker 交给调用方，
    // 之后的每次执行才开始计 50ms 超时——冷启动成本一次付清，不摊给用户代码。
    const PING_ID = 0;
    let settled = false;
    const bootTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup(w);
      reject(new Error("沙箱线程启动超时"));
    }, 10_000);
    w.once("message", (msg: SandboxResponse) => {
      if (msg.id === PING_ID) {
        if (settled) return;
        settled = true;
        clearTimeout(bootTimer);
        online = true;
        booting = null;
        // 启动完成：唤醒正在等排空的调用方（首跑期间的 sandboxIdle 挂在这里）
        notifyIdle();
        // worker 不阻止进程自然退出（测试与 CLI 场景；常驻服务由事件循环维持）
        w.unref();
        resolve(w);
        return;
      }
      onMessage(msg);
    });
    w.on("message", (msg: SandboxResponse) => {
      if (msg.id === PING_ID) return; // 已由上面的 once 处理
      onMessage(msg);
    });
    w.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(bootTimer);
      cleanup(w);
      failAll(err.message || "沙箱线程异常");
      reject(err);
    });
    w.on("exit", (code) => {
      // 被主线程 terminate（超时硬杀）或崩溃都走这里；
      // pending 已由 failAll 清理过，这里只做引用清理。
      if (!settled) {
        settled = true;
        clearTimeout(bootTimer);
        cleanup(w);
        booting = null;
        notifyIdle(); // 启动失败也要唤醒排空等待者（它们会重试 spawn）
        reject(new Error(`沙箱线程启动失败（code=${code}）`));
        return;
      }
      cleanup(w);
      if (code !== 0 && online) log.warn("沙箱线程异常退出（code=%d）", code);
    });
    // 发探活请求：worker 模块加载完成、消息端口就绪后才会回包
    w.postMessage({ id: PING_ID, code: "return 0;", bars: [], state: {}, symbol: "__boot__", timeoutMs: 1000 } as SandboxRequest);
  });
  return booting;
}

/** 常驻消息处理（探活完成后的正式请求/日志都走这里）。 */
function onMessage(msg: SandboxResponse): void {
  // log 通道（id=-1）：转主进程日志，不对应任何 pending
  if (msg.id === -1 && msg.logText) {
    log.info("[自定义策略] %s", msg.logText);
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (p.timer) clearTimeout(p.timer);
  p.resolve(msg);
}

function cleanup(w: Worker): void {
  if (worker === w) {
    worker = null;
    online = false;
    booting = null;
  }
}

/** 清空所有在途请求（worker 失效时）。 */
function failAll(message: string): void {
  for (const [, p] of pending) {
    if (p.timer) clearTimeout(p.timer);
    p.resolve({ id: -1, ok: false, error: message });
  }
  pending.clear();
  notifyIdle();
}

/**
 * 在途执行计数（含「已发起、还没进 pending 的微任务窗口」）。
 *
 * generate 必须在**第一个 await 之前**同步调 sandboxBegin()：从信号产生到
 * 沙箱请求注册进 pending 之间隔着几个微任务跳，只看 pending.size 会在那个
 * 窗口里误判「已排空」。同步计数没有这个竞态。
 */
let inflight = 0;

/** 标记一次策略执行开始（同步调用，杜绝排空误判）。 */
export function sandboxBegin(): void {
  inflight++;
}

/** 标记一次策略执行结束；归零时唤醒排空等待者。 */
export function sandboxEnd(): void {
  inflight = Math.max(0, inflight - 1);
  notifyIdle();
}

/** 沙箱排空等待者：在途请求清零时唤醒（回测逐根喂入用）。 */
let idleWaiters: (() => void)[] = [];

/** 在途请求清零时唤醒所有等待者。 */
function notifyIdle(): void {
  if (inflight === 0 && pending.size === 0 && idleWaiters.length > 0) {
    const ws = idleWaiters;
    idleWaiters = [];
    for (const w of ws) w();
  }
}

/**
 * 等沙箱排空（所有在途执行完成、无启动中的 worker）。
 *
 * 为什么需要：回测把几百根 K 线一口气灌进总线，同步策略（momentum 等）的信号
 * 在当根就完成派发，而自定义策略要走一次 worker 往返（毫秒级）——不排空的话
 * 所有信号都积压到回放结束才落地，订单互相取代、永远等不到「下一根 K 线」成交。
 * 回测逐根喂入时在每根之后 await 这个函数，异步策略与同步策略就站在同一时序上
 * （信号 t 收盘 → t+1 开盘成交），不改变任何费用/滑点/防未来函数守卫。
 */
export function sandboxIdle(): Promise<void> {
  if (inflight === 0 && pending.size === 0 && !booting) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

/**
 * 在沙箱里执行一段策略代码。
 * 超时（硬杀 worker）或 worker 内报错都以 Error 抛出；成功返回 {value, state}。
 * worker 冷启动时间不计入超时：先等启动完成，再开始 50ms 计时。
 */
export function runInSandbox(args: {
  code: string;
  bars: unknown;
  state: unknown;
  symbol: string;
}): Promise<{ value: unknown; state: unknown }> {
  return spawn().then(
    (w) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          // 硬杀：死循环策略没有合作终止的可能。所有在途请求一起失败。
          log.warn("自定义策略执行超时（>%dms），已重置沙箱线程", SANDBOX_TIMEOUT_MS);
          void w.terminate();
          cleanup(w);
          failAll(`策略执行超时（>${SANDBOX_TIMEOUT_MS}ms）：请检查是否有超深循环`);
          reject(new Error(`策略执行超时（>${SANDBOX_TIMEOUT_MS}ms）：请检查是否有超深循环`));
        }, SANDBOX_TIMEOUT_MS);
        pending.set(id, {
          resolve: (msg) => {
            if (msg.ok) resolve({ value: msg.value, state: msg.state });
            else reject(new Error(msg.error ?? "沙箱执行失败"));
          },
          timer,
        });
        const req: SandboxRequest = {
          id,
          code: args.code,
          bars: args.bars,
          state: args.state,
          symbol: args.symbol,
          timeoutMs: SANDBOX_TIMEOUT_MS,
        };
        try {
          w.postMessage(req);
        } catch (err) {
          clearTimeout(timer);
          pending.delete(id);
          cleanup(w);
          reject(new Error(`沙箱线程不可用: ${(err as Error).message}`));
        }
      }),
    // spawn 失败（worker 启动即崩）：直接报错
    (err) => {
      throw new Error(`沙箱线程启动失败: ${(err as Error).message}`);
    },
  );
}
