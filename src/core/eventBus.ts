/**
 * 轻量级事件总线：Agent 之间唯一的通信方式。
 *
 * 原则：
 * - Agent 之间不直接调用，全部通过 Topic 广播解耦；
 * - 事件全量留痕（history，带上限），便于调试与审计；
 * - publish 为同步派发（fire-and-forget），publishAsync 顺序 await 每个处理器，
 *   流水线内统一使用 publishAsync 保证顺序确定。
 */

import type { Allocation, Signal } from "./types.js";

export const Topic = {
  BAR: "market.bar",
  MARKET_VIEW: "agent.market_view",
  SIGNAL: "strategy.signal",
  ALLOCATION: "strategy.allocation",
  ORDER_INTENT: "exec.order_intent",
  ORDER_REJECTED: "exec.order_rejected",
  FILL: "exec.fill",
  ENGINE: "engine.status",
} as const;

export type { Allocation as AllocationEvent };
export type TopicName = (typeof Topic)[keyof typeof Topic];

export type Handler<T = unknown> = (event: Event<T>) => void | Promise<void>;

export interface Event<T = unknown> {
  topic: string;
  payload: T;
  /** 单调递增序号 */
  seq: number;
  /** Unix 毫秒 */
  timestamp: number;
}

export interface EventBusOptions {
  /** history 保留上限，默认 5000 */
  historyLimit?: number;
}

export class EventBus {
  private readonly handlers = new Map<string, Handler[]>();
  private readonly historyLimit: number;
  private buf: Event[] = [];
  private seq = 0;

  constructor(options: EventBusOptions = {}) {
    this.historyLimit = options.historyLimit ?? 5000;
  }

  subscribe<T>(topic: string, handler: Handler<T>): void {
    const list = this.handlers.get(topic) ?? [];
    list.push(handler as Handler);
    this.handlers.set(topic, list);
  }

  unsubscribe(topic: string, handler: Handler): void {
    const list = this.handlers.get(topic);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }

  /** 同步派发：异步处理器不会被等待。 */
  publish<T>(topic: string, payload: T): Event<T> {
    const event: Event<T> = {
      topic,
      payload,
      seq: ++this.seq,
      timestamp: Date.now(),
    };
    for (const handler of [...(this.handlers.get(topic) ?? [])]) {
      void handler(event as Event);
    }
    this.push(event as Event);
    return event;
  }

  /** 顺序派发：await 每个处理器，流水线请用这个。 */
  async publishAsync<T>(topic: string, payload: T): Promise<Event<T>> {
    const event: Event<T> = {
      topic,
      payload,
      seq: ++this.seq,
      timestamp: Date.now(),
    };
    for (const handler of [...(this.handlers.get(topic) ?? [])]) {
      await handler(event as Event);
    }
    this.push(event as Event);
    return event;
  }

  history(topic?: string): Event[] {
    return topic ? this.buf.filter((e) => e.topic === topic) : [...this.buf];
  }

  clear(): void {
    this.handlers.clear();
    this.buf = [];
  }

  private push(event: Event): void {
    this.buf.push(event);
    if (this.buf.length > this.historyLimit) {
      this.buf = this.buf.slice(-this.historyLimit);
    }
  }
}

/** 便捷构造：把 Signal 包装成 SIGNAL 事件并发布。 */
export function publishSignal(bus: EventBus, signal: Signal): void {
  bus.publish(Topic.SIGNAL, signal);
}
