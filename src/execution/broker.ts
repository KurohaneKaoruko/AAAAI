/** 执行层抽象：把 OrderIntent 变成 Fill（或交易所订单）。 */

import type { Fill, OrderIntent } from "../core/types.js";

export interface Broker {
  readonly name: string;
  /** true = 本地模拟成交（不动真钱） */
  readonly paper: boolean;
  /** 订阅 ORDER_INTENT 后由本方法处理；成交/拒单通过事件广播。 */
  handle(intent: OrderIntent): Promise<Fill | null>;
}
