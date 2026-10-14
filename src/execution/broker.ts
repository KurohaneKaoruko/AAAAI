/** 执行层抽象：把 OrderIntent 变成 Fill。 */

import type { Fill, OrderIntent } from "../core/types.js";

export interface Broker {
  readonly name: string;
  /** true = 不产生真实订单（模拟） */
  readonly paper: boolean;
  submit(intent: OrderIntent): Promise<Fill | null>;
}
