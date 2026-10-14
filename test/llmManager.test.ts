import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmManager, type BalanceStrategy } from "../src/llm/llmManager.js";
import { SecretStore } from "../src/store/secrets.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "aaaaai-llm-"));
}

/** 创建一个指向不可达地址的实例，用于测试失败/熔断路径。 */
function deadProfile(manager: LlmManager, label: string, weight = 1) {
  return manager.create({
    label,
    baseUrl: "http://127.0.0.1:9/api", // 必然连接失败
    model: "test-model",
    apiKey: "k",
    weight,
  });
}

test("SecretStore: 命名空间隔离与部分更新", () => {
  const dir = tmpDir();
  try {
    const store = new SecretStore(dir);
    const ns = store.namespace("conn");
    store.set(ns("abc"), { apiKey: "K1", apiSecret: "S1" });
    store.set(store.namespace("llm")("abc"), { apiKey: "K2", apiSecret: "S2" });
    assert.equal(store.get(ns("abc")).apiKey, "K1", "不同命名空间互不覆盖");
    assert.equal(store.get(store.namespace("llm")("abc")).apiKey, "K2");

    store.patch(ns("abc"), { apiKey: "" }); // 空值不覆盖
    assert.equal(store.get(ns("abc")).apiKey, "K1");
    store.patch(ns("abc"), { apiKey: "K1-new" });
    assert.equal(store.get(ns("abc")).apiKey, "K1-new");

    assert.equal(store.hasKey(ns("abc")), true);
    assert.equal(store.hasKey(ns("nope")), false);

    // 重新加载实例后仍可读
    const reloaded = new SecretStore(dir);
    assert.equal(reloaded.get(ns("abc")).apiKey, "K1-new");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LlmManager: 配置增删改查与密钥脱敏", () => {
  const dir = tmpDir();
  try {
    const m = new LlmManager(dir);
    const created = m.create({
      label: "主模型",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-secret",
      weight: 10,
    });
    assert.equal(created.hasKey, true);
    assert.equal(JSON.stringify(m.list()).includes("sk-secret"), false, "列表不得泄露密钥");

    const updated = m.update(created.id, { label: "改名", weight: 999 });
    assert.equal(updated.label, "改名");
    assert.equal(updated.weight, 100, "权重应被夹到 1~100");
    assert.equal(updated.hasKey, true, "未传密钥时不应清空");

    m.update(created.id, { enabled: false });
    assert.equal(m.get(created.id)!.enabled, false);

    m.remove(created.id);
    assert.equal(m.list().length, 0);
    assert.throws(() => m.update("nope", {}), /不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LlmManager: 配置持久化", () => {
  const dir = tmpDir();
  try {
    const m1 = new LlmManager(dir);
    const p = m1.create({ label: "A", baseUrl: "https://a.test/v1", model: "m", apiKey: "k" });
    const m2 = new LlmManager(dir);
    assert.equal(m2.list().length, 1);
    assert.equal(m2.list()[0]!.id, p.id);
    assert.equal(m2.list()[0]!.hasKey, true, "密钥应从共享 secrets.json 恢复");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("负载均衡 · 轮询：均匀分配", () => {
  const dir = tmpDir();
  try {
    const m = new LlmManager(dir, "round-robin");
    const a = m.create({ label: "A", baseUrl: "https://a.test/v1", model: "m", apiKey: "k" });
    const b = m.create({ label: "B", baseUrl: "https://b.test/v1", model: "m", apiKey: "k" });
    const c = m.create({ label: "C", baseUrl: "https://c.test/v1", model: "m", apiKey: "k" });

    const picks = Array.from({ length: 9 }, () => m.pick()!.id);
    assert.deepEqual(picks, [a.id, b.id, c.id, a.id, b.id, c.id, a.id, b.id, c.id], "轮询应严格循环");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("负载均衡 · 加权：按权重比例分配", () => {
  const dir = tmpDir();
  try {
    const m = new LlmManager(dir, "weighted");
    const big = m.create({ label: "big", baseUrl: "https://a.test/v1", model: "m", apiKey: "k", weight: 3 });
    const small = m.create({ label: "small", baseUrl: "https://b.test/v1", model: "m", apiKey: "k", weight: 1 });

    const counts = new Map<string, number>();
    for (let i = 0; i < 40; i += 1) {
      const id = m.pick()!.id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    assert.equal(counts.get(big.id), 30, "权重 3:1 应得到 30 次");
    assert.equal(counts.get(small.id), 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("负载均衡 · 最低延迟优先", () => {
  const dir = tmpDir();
  try {
    const m = new LlmManager(dir, "latency");
    const slow = m.create({ label: "slow", baseUrl: "https://a.test/v1", model: "m", apiKey: "k" });
    const fast = m.create({ label: "fast", baseUrl: "https://b.test/v1", model: "m", apiKey: "k" });
    // 手工注入统计：slow 延迟高、fast 延迟低
    m["stats"]!.set(slow.id, {
      calls: 5, success: 5, failures: 0, consecutiveFailures: 0,
      avgLatencyMs: 900, lastLatencyMs: 900, lastError: "", lastUsedAt: "", cooldownUntil: 0,
    });
    m["stats"]!.set(fast.id, {
      calls: 5, success: 5, failures: 0, consecutiveFailures: 0,
      avgLatencyMs: 80, lastLatencyMs: 80, lastError: "", lastUsedAt: "", cooldownUntil: 0,
    });
    const picks = Array.from({ length: 5 }, () => m.pick()!.id);
    assert.ok(picks.every((id) => id === fast.id), "应始终选延迟最低的实例");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("熔断：连续失败后进入冷却并被排除", async () => {
  const dir = tmpDir();
  try {
    const m = new LlmManager(dir, "round-robin", { breakerThreshold: 2, cooldownMs: 60_000 });
    // 只有一个不可达实例：每次 complete 都只会打到它
    const bad = deadProfile(m, "坏实例");

    for (let i = 0; i < 2; i += 1) {
      await m.complete("hi").catch(() => undefined);
    }
    const badStat = m.list().find((p) => p.id === bad.id)!.stats;
    assert.ok(badStat.failures >= 2, "坏实例应累计失败");
    assert.ok(badStat.cooldownUntil > Date.now(), "达到阈值后应进入冷却");

    const view = m.list().find((p) => p.id === bad.id)!;
    assert.equal(view.healthy, false);
    assert.equal(m.available().length, 0, "冷却期内无可用实例");
    assert.equal(m.overview().available, 0);

    // 之后新增的健康实例仍应立即可用（不被熔断牵连）
    const good = m.create({ label: "好实例", baseUrl: "https://good.test/v1", model: "m", apiKey: "k" });
    assert.ok(m.available().some((p) => p.id === good.id), "健康实例仍可用");
    assert.equal(m.overview().available, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("熔断：冷却期内立即不可用（长冷却）", async () => {
  const dir = tmpDir();
  try {
    const m = new LlmManager(dir, "round-robin", { breakerThreshold: 1, cooldownMs: 60_000 });
    const p = deadProfile(m, "实例");
    await m.complete("hi").catch(() => undefined);
    assert.equal(m.available().some((x) => x.id === p.id), false, "熔断后应立即从调度池移除");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("熔断后可恢复：冷却到期重新参与调度", async () => {
  const dir = tmpDir();
  try {
    // 冷却设为 50ms，避免断言与冷却到期产生竞态
    const m = new LlmManager(dir, "round-robin", { breakerThreshold: 1, cooldownMs: 50 });
    const p = deadProfile(m, "实例");
    await m.complete("hi").catch(() => undefined);
    assert.equal(m.available().some((x) => x.id === p.id), false, "刚熔断应不可用");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(m.available().some((x) => x.id === p.id), true, "冷却到期后半开，重新参与调度");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("故障转移：首个实例失败时自动换下一个", async () => {
  const dir = tmpDir();
  try {
    const m = new LlmManager(dir, "round-robin", { breakerThreshold: 5, cooldownMs: 60_000 });
    const bad = deadProfile(m, "坏");
    const alsoBad = deadProfile(m, "也坏");
    let calls = 0;
    // 拦截 fetch：第一个实例立即失败，第二个返回固定文本
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("good.test")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "来自健康实例" } }] }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error("connection refused");
    }) as typeof fetch;
    try {
      m.create({ label: "good", baseUrl: "https://good.test/v1", model: "m", apiKey: "k" });
      // 把 good 放在轮询首位
      const picked = m.pick();
      assert.ok(picked);
      const text = await m.complete("hi");
      assert.equal(text, "来自健康实例", "应成功故障转移到健康实例");
      assert.ok(calls >= 2, "应至少尝试过两个实例");
      assert.ok(
        m.list().filter((p) => p.stats.calls > 0).length >= 2,
        "至少两个实例应记录了调用",
      );
      assert.ok(bad.id && alsoBad.id);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("无可用实例时抛出可读错误", async () => {
  const dir = tmpDir();
  try {
    const m = new LlmManager(dir);
    await assert.rejects(() => m.complete("hi"), /没有可用的对话模型/);
    // 指定类型时错误信息应点名该类型
    await assert.rejects(() => m.complete("hi", "systemone"), /没有可用的 System One 决策模型/);
    // 只有一个没有 Key 的实例同样不可用
    m.create({ label: "无密钥", baseUrl: "https://a.test/v1", model: "m", apiKey: "" });
    await assert.rejects(() => m.complete("hi"), /没有可用的对话模型/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("统计：调用数/成功数/汇总可读且可重置", async () => {
  const dir = tmpDir();
  try {
    const m = new LlmManager(dir, "round-robin");
    const p = m.create({ label: "A", baseUrl: "https://a.test/v1", model: "m", apiKey: "k" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    try {
      await m.complete("hi");
      await m.complete("hi");
      const view = m.list().find((x) => x.id === p.id)!;
      assert.equal(view.stats.calls, 2);
      assert.equal(view.stats.success, 2);
      assert.ok(view.stats.avgLatencyMs >= 0);
      const overview = m.overview();
      assert.equal(overview.total, 1);
      assert.equal(overview.calls, 2);
      assert.equal(overview.success, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
    m.resetStats(p.id);
    assert.equal(m.list().find((x) => x.id === p.id)!.stats.calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("策略切换：setStrategy 立即影响选点", () => {
  const dir = tmpDir();
  try {
    const m = new LlmManager(dir, "random");
    assert.equal(m.getStrategy(), "random");
    m.create({ label: "A", baseUrl: "https://a.test/v1", model: "m", apiKey: "k" });
    m.create({ label: "B", baseUrl: "https://b.test/v1", model: "m", apiKey: "k" });
    m.setStrategy("round-robin" as BalanceStrategy);
    assert.equal(m.getStrategy(), "round-robin");
    const ids = Array.from({ length: 4 }, () => m.pick()!.id);
    assert.equal(new Set(ids).size, 2, "两个实例应交替出现");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("未配置密钥的实例不参与调度", () => {
  const dir = tmpDir();
  try {
    const m = new LlmManager(dir, "round-robin");
    const withKey = m.create({ label: "有密钥", baseUrl: "https://a.test/v1", model: "m", apiKey: "k" });
    m.create({ label: "无密钥", baseUrl: "https://b.test/v1", model: "m", apiKey: "" });
    const picks = Array.from({ length: 6 }, () => m.pick()!.id);
    assert.ok(picks.every((id) => id === withKey.id), "无密钥实例不应被选中");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});