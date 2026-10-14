/** Agent 基类：一个 Agent = 一组「订阅 Topic -> 处理方法」。 */

import type { EventBus, Handler } from "../core/eventBus.js";

export interface Subscription {
  topic: string;
  handler: Handler;
}

export abstract class Agent {
  abstract readonly name: string;

  constructor(protected readonly bus: EventBus) {}

  /** 声明订阅表；构造后由 attach 注册。 */
  protected abstract subscriptions(): Subscription[];

  attach(): this {
    for (const sub of this.subscriptions()) {
      this.bus.subscribe(sub.topic, sub.handler);
    }
    return this;
  }
}
