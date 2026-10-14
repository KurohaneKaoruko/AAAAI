import assert from "node:assert/strict";
import test from "node:test";
import { EventBus, Topic } from "../src/core/eventBus.js";

test("EventBus: publish 同步通知订阅者并留痕", () => {
  const bus = new EventBus();
  const got: number[] = [];
  bus.subscribe(Topic.SIGNAL, (e) => got.push(e.payload as number));
  bus.publish(Topic.SIGNAL, 1);
  bus.publish(Topic.SIGNAL, 2);
  assert.deepEqual(got, [1, 2]);
  assert.equal(bus.history(Topic.SIGNAL).length, 2);
  assert.equal(bus.history().length, 2);
  // 序号单调递增
  const seqs = bus.history().map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test("EventBus: publishAsync 按订阅顺序 await", async () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.subscribe(Topic.BAR, async () => {
    await new Promise((r) => setTimeout(r, 10));
    order.push("slow");
  });
  bus.subscribe(Topic.BAR, () => order.push("fast"));
  await bus.publishAsync(Topic.BAR, null);
  assert.deepEqual(order, ["slow", "fast"]);
});

test("EventBus: unsubscribe 后不再通知", () => {
  const bus = new EventBus();
  let count = 0;
  const handler = () => {
    count += 1;
  };
  bus.subscribe(Topic.FILL, handler);
  bus.publish(Topic.FILL, null);
  bus.unsubscribe(Topic.FILL, handler);
  bus.publish(Topic.FILL, null);
  assert.equal(count, 1);
});

test("EventBus: history 受上限约束", () => {
  const bus = new EventBus({ historyLimit: 3 });
  for (let i = 0; i < 10; i += 1) bus.publish(Topic.BAR, i);
  assert.equal(bus.history().length, 3);
});
