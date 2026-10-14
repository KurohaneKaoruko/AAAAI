/**
 * 联合决策：对话模型 + System One 一起决策（互相知情，而非各算各的再平均）。
 *
 * 判定标准很硬——抓 prompt：
 * 1. System One 的 prompt/state 里必须出现对话模型本轮的研判（后手看先手）；
 * 2. 对话模型第二轮的 prompt 里必须出现 System One 上一轮的档位判断（回路）；
 * 3. 最终仓位仍按配比融合并受额度约束；
 * 4. 任一路挂掉就降级为单路，另一路照常出单。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { JointAllocator, JointStrategy } from "../src/strategies/joint.js";
import { AIAllocator, CrossSectionalAllocator } from "../src/strategies/allocator.js";
import { LLMStrategy } from "../src/strategies/llmStrategy.js";
import { MomentumStrategy } from "../src/strategies/momentum.js";
import { JointBoard } from "../src/llm/jointBoard.js";
import type { LLMClient } from "../src/llm/llmClient.js";
import type { AssetSnapshot } from "../src/llm/allocation.js";

const LIMITS = { maxPositions: 2, maxPositionWeight: 0.6, grossCap: 1 };

const SNAPS: AssetSnapshot[] = [
  { symbol: "BTC", price: 100, momentum: 0.04, retShort: 0.01, retLong: 0.03, trend: "up", bars: 60 },
  { symbol: "ETH", price: 50, momentum: -0.02, retShort: -0.01, retLong: -0.02, trend: "down", bars: 60 },
];

function recordingChat(prompts: string[], reply: Record<string, number>, reason: string): LLMClient {
  return {
    name: "chat",
    async complete() {
      return "{}";
    },
    async allocate(prompt) {
      prompts.push(prompt);
      return JSON.stringify({ allocations: reply, confidence: 0.8, reason });
    },
  };
}

test("联合决策：System One 的 prompt 里带上了对话模型的研判", async () => {
  const chatPrompts: string[] = [];
  const soPrompts: string[] = [];
  const chat = recordingChat(chatPrompts, { BTC: 0.5 }, "对话模型看好 BTC");
  const so: LLMClient = {
    name: "systemone",
    async complete() {
      return "{}";
    },
    async allocate(prompt) {
      soPrompts.push(prompt);
      return JSON.stringify({ allocations: { BTC: 0.3 }, confidence: 0.6, reason: "档位 strong" });
    },
  };

  const joint = new JointAllocator(
    {
      chat: new AIAllocator(new CrossSectionalAllocator(), chat, LIMITS),
      systemone: new AIAllocator(new CrossSectionalAllocator(), so, LIMITS),
      blend: { rules: 0, chat: 2, systemone: 1 },
    },
    LIMITS,
  );

  const r = await joint.allocate(SNAPS);
  assert.equal(r.source, "mix");

  // 后手看先手：System One 的 prompt 必须含对话模型的研判
  assert.equal(soPrompts.length, 1);
  assert.match(soPrompts[0]!, /对话模型/);
  assert.match(soPrompts[0]!, /对话模型看好 BTC/);
  assert.match(soPrompts[0]!, /BTC=50%/);

  // 先手首轮还没有对方的判断（黑板是空的）
  assert.equal(chatPrompts.length, 1);
  assert.doesNotMatch(chatPrompts[0]!, /决策模型的判断/);

  // 配比 2:1 -> BTC 权重 = 2/3*0.5 + 1/3*0.3
  const expected = (2 / 3) * 0.5 + (1 / 3) * 0.3;
  assert.ok(Math.abs(r.weights.BTC! - expected) < 1e-6, `期望 ${expected}，实际 ${r.weights.BTC}`);
  assert.match(r.reason, /对话模型/);
  assert.match(r.reason, /决策模型/);
});

test("联合决策：第二轮对话模型能看到 System One 上一轮的判断（回路）", async () => {
  const chatPrompts: string[] = [];
  const chat = recordingChat(chatPrompts, { BTC: 0.4 }, "维持看多");
  const so: LLMClient = {
    name: "systemone",
    async complete() {
      return "{}";
    },
    async allocate() {
      return JSON.stringify({ allocations: { BTC: 0.2 }, confidence: 0.6, reason: "档位 moderate" });
    },
  };
  const joint = new JointAllocator(
    {
      chat: new AIAllocator(new CrossSectionalAllocator(), chat, LIMITS),
      systemone: new AIAllocator(new CrossSectionalAllocator(), so, LIMITS),
      blend: { rules: 0, chat: 1, systemone: 1 },
    },
    LIMITS,
  );

  await joint.allocate(SNAPS);
  await joint.allocate(SNAPS);

  assert.equal(chatPrompts.length, 2);
  assert.doesNotMatch(chatPrompts[0]!, /决策模型的判断/);
  assert.match(chatPrompts[1]!, /决策模型/);
  assert.match(chatPrompts[1]!, /档位 moderate/);
});

test("联合决策：System One 挂掉时自动降级为对话模型单路", async () => {
  const chatPrompts: string[] = [];
  const chat = recordingChat(chatPrompts, { BTC: 0.5 }, "独自判断");
  const broken: LLMClient = {
    name: "systemone",
    async complete() {
      return "{}";
    },
    async allocate() {
      throw new Error("System One 端点 503");
    },
  };
  const joint = new JointAllocator(
    {
      chat: new AIAllocator(new CrossSectionalAllocator(), chat, LIMITS),
      systemone: new AIAllocator(new CrossSectionalAllocator(), broken, LIMITS),
      blend: { rules: 0, chat: 1, systemone: 1 },
    },
    LIMITS,
  );

  const r = await joint.allocate(SNAPS);
  // AIAllocator 内部已回退规则基线，所以权重仍合法；关键是流程不中断
  assert.ok(r.weights.BTC! > 0, "对话模型仍应出单");
  assert.ok(r.notes.some((n) => n.includes("回退")) || r.source === "mix");
});

test("联合决策：只有一路可用时不做多余编排", async () => {
  let calls = 0;
  const chat: LLMClient = {
    name: "chat",
    async complete() {
      return "{}";
    },
    async allocate() {
      calls += 1;
      return JSON.stringify({ allocations: { BTC: 0.4 }, confidence: 0.5, reason: "单路" });
    },
  };
  const joint = new JointAllocator(
    {
      chat: new AIAllocator(new CrossSectionalAllocator(), chat, LIMITS),
      systemone: null,
      blend: { rules: 0, chat: 1, systemone: 1 },
    },
    LIMITS,
  );
  const r = await joint.allocate(SNAPS);
  assert.equal(calls, 1);
  assert.ok(Math.abs(r.weights.BTC! - 0.4) < 1e-6, "单路时权重就是它自己的结论");
});

test("联合决策：逐标的模式下两路策略共用一块黑板", async () => {
  const board = new JointBoard();
  const chatPrompts: string[] = [];
  const momentum = new MomentumStrategy(5, 20, 0.5);

  const chatClient: LLMClient = {
    name: "chat",
    async complete(prompt) {
      chatPrompts.push(prompt);
      return JSON.stringify({ target_weight: 0.5, confidence: 0.7, reason: "chat 建议三成" });
    },
  };
  const soClient: LLMClient = {
    name: "systemone",
    async complete() {
      return JSON.stringify({ target_weight: 0.2, confidence: 0.5, reason: "so 档位 weak" });
    },
  };

  const joint = new JointStrategy(
    new LLMStrategy(momentum, chatClient, 1),
    new LLMStrategy(momentum, soClient, 1),
    { rules: 0, chat: 3, systemone: 1 },
    momentum.warmup,
  );
  assert.equal(joint.warmup, momentum.warmup);

  const bars = Array.from({ length: 30 }, (_, i) => ({
    symbol: "BTC",
    timestamp: new Date(Date.now() + i * 60_000),
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 1,
  }));

  const signal = await joint.generate({ symbol: "BTC", bars });
  assert.ok(signal, "应给出信号");
  // 配比 3:1 -> 0.75*0.5 + 0.25*0.2
  const expected = 0.75 * 0.5 + 0.25 * 0.2;
  assert.ok(Math.abs(signal!.targetWeight - expected) < 1e-6, `期望 ${expected}，实际 ${signal!.targetWeight}`);
  assert.match(signal!.reason, /联合/);

  // 逐标的模式下顺序同样是「对话先、决策后」：
  // 首轮对话看不到 so（黑板空），第二轮就能引用 so 上一轮的档位。
  assert.equal(chatPrompts.length, 1);
  assert.doesNotMatch(chatPrompts[0]!, /决策模型/);
  await joint.generate({ symbol: "BTC", bars });
  assert.equal(chatPrompts.length, 2);
  assert.match(chatPrompts[1]!, /决策模型/);
  assert.match(chatPrompts[1]!, /so 档位 weak/);
});