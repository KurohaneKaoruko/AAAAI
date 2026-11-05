/**
 * 自定义策略（custom 引擎）测试。
 *
 * 重点不是指标数学（那些在各自的策略测试里），而是四件「不能出事」的事：
 *   1. 沙箱隔离——用户代码摸不到 require/process/fetch；
 *   2. 死循环防护——超时被掐断并报可读的错误；
 *   3. 返回值收敛——数字/对象/null/NaN 都不会炸流水线；
 *   4. 持久状态——state 每标的独立，跨 K 线可读写。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomStrategy, compileCustomCode, lintCustomCode } from "../src/strategies/customStrategy.js";
import { StrategyStore } from "../src/strategies/profileStore.js";
import type { Bar } from "../src/core/types.js";

function bars(n: number, base = 100): Bar[] {
  const out: Bar[] = [];
  let price = base;
  for (let i = 0; i < n; i++) {
    // 缓慢单边上涨 + 少量抖动：让均线策略有明确方向
    price *= 1 + (i % 7 === 0 ? -0.002 : 0.004);
    const t = new Date(Date.UTC(2026, 0, 1, 0, i * 5));
    out.push({ symbol: "TESTUSDT", timestamp: t, open: price * 0.999, high: price * 1.001, low: price * 0.998, close: price, volume: 1000 + i });
  }
  return out;
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "strategy-custom-"));
}

test("自定义策略: 基本信号（双均线金叉给出仓位）", async () => {
  const s = new CustomStrategy({ code: `const f = helpers.sma(bars, 3); const sl = helpers.sma(bars, 8); if (f.length < 1) return 0; return f[f.length-1] > sl[sl.length-1] ? 0.5 : 0;` });
  const list = bars(40);
  const sig = await s.generate({ symbol: "TESTUSDT", bars: list });
  // 上涨序列金叉后应给出 0.5
  assert.ok(sig, "上涨序列应给出信号");
  assert.equal(sig!.targetWeight, 0.5);
  assert.equal(sig!.symbol, "TESTUSDT");
});

test("自定义策略: 沙箱隔离（require/process/fetch 都拿不到）", async () => {
  // 用拼接写法绕过文本 lint（lint 只认源码字面），运行期语义完全一致：
  const code = `const req = "requi" + "re"; const pro = "pro" + "cess"; return typeof globalThis[req] === "undefined" && typeof globalThis[pro] === "undefined" && typeof fetch === "undefined" ? 1 : 0;`;
  const s = new CustomStrategy({ code });
  const sig = await s.generate({ symbol: "X", bars: bars(20) });
  assert.equal(sig?.targetWeight, 1, "沙箱里不该有 require/process/fetch");
});

test("自定义策略: lint 拒绝危险写法", () => {
  assert.throws(() => lintCustomCode("const fs = require('fs');"), /require/);
  assert.throws(() => lintCustomCode("return process.env.KEY;"), /process/);
  assert.throws(() => lintCustomCode("eval('1+1'); return 0;"), /eval/);
  assert.throws(() => lintCustomCode("while (true) { } return 0;"), /死循环/);
  assert.throws(() => lintCustomCode(""), /为空/);
});

test("自定义策略: 死循环被超时掐断，报可读错误", async () => {
  const s = new CustomStrategy({ code: `let i = 0; while (i >= 0) { i++; } return 0;` });
  await assert.rejects(
    () => s.generate({ symbol: "X", bars: bars(20) }),
    /超时/,
    "死循环应在 50ms 超时被掐断",
  );
});

test("自定义策略: 运行期异常报可读错误（不是 undefined 崩栈）", async () => {
  const s = new CustomStrategy({ code: `return bars.map(b => b.nope.x).length;` });
  await assert.rejects(() => s.generate({ symbol: "X", bars: bars(20) }), /策略运行报错/);
});

test("自定义策略: 返回值收敛（null=不动、NaN=0、对象带 reason、超界钳 1）", async () => {
  const ctx = bars(20);
  const none = new CustomStrategy({ code: `return null;` });
  assert.equal(await none.generate({ symbol: "X", bars: ctx }), null);

  const nan = new CustomStrategy({ code: `return NaN;` });
  const nanSig = await nan.generate({ symbol: "X", bars: ctx });
  assert.equal(nanSig?.targetWeight, 0, "NaN 应收敛为 0（空仓）");

  const obj = new CustomStrategy({ code: `return { weight: 0.8, reason: "金叉" };` });
  const objSig = await obj.generate({ symbol: "X", bars: ctx });
  assert.equal(objSig?.targetWeight, 0.8);
  assert.equal(objSig?.reason, "金叉");

  const over = new CustomStrategy({ code: `return 5;` });
  assert.equal((await over.generate({ symbol: "X", bars: ctx }))?.targetWeight, 1, "超界钳到 1");

  const neg = new CustomStrategy({ code: `return -0.5;` });
  assert.equal((await neg.generate({ symbol: "X", bars: ctx }))?.targetWeight, 0, "现货负目标钳到 0");
  const negShort = new CustomStrategy({ code: `return -0.5;`, allowShort: true });
  assert.equal((await negShort.generate({ symbol: "X", bars: ctx }))?.targetWeight, -0.5, "合约保留负目标");
});

test("自定义策略: state 跨 K 线持久且每标的独立", async () => {
  const s = new CustomStrategy({ code: `state.n = (state.n ?? 0) + 1; return Math.min(state.n / 10, 1);` });
  const list = bars(30);
  const t1 = await s.generate({ symbol: "TUSD", bars: list.slice(0, 20) });
  const t2 = await s.generate({ symbol: "TUSD", bars: list.slice(0, 21) });
  const b1 = await s.generate({ symbol: "BBB", bars: list.slice(0, 20) });
  assert.equal(t1?.targetWeight, 0.1, "TUSD 第 1 次：n=1 → 0.1");
  assert.equal(t2?.targetWeight, 0.2, "TUSD 第 2 次：n=2 → 0.2（state 递增）");
  assert.equal(b1?.targetWeight, 0.1, "BBB 独立 state，从头计数");
});

test("自定义策略: 指标助手数学（sma/rsi/atr/crossover）", async () => {
  // sma 均值正确性
  const s = new CustomStrategy({
    code: `const c = bars.map(b => b.close); const m = helpers.sma(bars, 5); const want = (c[c.length-1]+c[c.length-2]+c[c.length-3]+c[c.length-4]+c[c.length-5])/5;
      if (Math.abs(m[m.length-1] - want) > 1e-9) return { weight: 0, reason: "sma 错:" + (m[m.length-1] - want) };
      if (helpers.crossover([1, 2], 1.5) !== true) return { weight: 0, reason: "crossover 错" };
      if (helpers.crossunder([2, 1], 1.5) !== true) return { weight: 0, reason: "crossunder 错" };
      const r = helpers.rsi(bars, 14); if (r.length < 1 || r[r.length-1] < 0 || r[r.length-1] > 100) return { weight: 0, reason: "rsi 越界" };
      const a = helpers.atr(bars, 14); if (a.length < 1 || a[a.length-1] <= 0) return { weight: 0, reason: "atr 异常" };
      return 1;`,
  });
  const sig = await s.generate({ symbol: "X", bars: bars(40) });
  assert.equal(sig?.targetWeight, 1, sig?.reason ?? "全部指标校验应通过");
});

test("自定义策略: warmup 不足时不出信号（不偷看未来）", async () => {
  const s = new CustomStrategy({ code: `return 1;` }); // 无指标调用 → 最小 warmup=10
  assert.equal(await s.generate({ symbol: "X", bars: bars(9) }), null, "9 根 < warmup 10，不出信号");
  assert.ok(await s.generate({ symbol: "X", bars: bars(10) }), "10 根应出信号");
});

test("自定义策略: warmup 从代码里的最大窗口推断", () => {
  const { warmup } = compileCustomCode(`const a = helpers.sma(bars, 48); const b = helpers.rsi(bars, 14); return a.length > b.length ? 0 : 0;`);
  assert.ok(warmup >= 48, "warmup 应覆盖最大窗口 48");
  assert.ok(warmup <= 200, "warmup 封顶 200");
});

test("profileStore: custom 策略保存时编译校验，坏代码被拒", () => {
  const dir = tmpDir();
  try {
    const store = new StrategyStore(dir);
    // 语法错误当场拒
    assert.throws(() => store.create({ name: "坏的", engine: "custom", strategyCode: "return ((;" }), /策略运行|编译|Unexpected|失败|Invalid|unexpected/i);
    // 危险写法当场拒
    assert.throws(() => store.create({ name: "危险的", engine: "custom", strategyCode: "require('fs')" }), /require/);
    // 好代码入库，strategyCode 持久化
    const ok = store.create({ name: "金叉", engine: "custom", strategyCode: "return helpers.crossover(helpers.sma(bars,5), helpers.sma(bars,20)) ? 0.5 : 0;" });
    assert.equal(ok.engine, "custom");
    assert.ok(ok.strategyCode.includes("crossover"));
    // 重读盘还在
    const store2 = new StrategyStore(dir);
    const back = store2.get(ok.id);
    assert.equal(back?.strategyCode, ok.strategyCode, "strategyCode 应持久化");
    // update 改成坏代码也当场拒，旧值保留
    assert.throws(() => store.update(ok.id, { strategyCode: "while(true){}" }), /死循环/);
    assert.equal(store.get(ok.id)?.strategyCode, ok.strategyCode, "校验失败时旧代码不被覆盖");
    // 非 custom 引擎不校验代码
    const mom = store.create({ name: "动量", engine: "momentum" });
    assert.equal(mom.strategyCode, "", "非 custom 引擎 strategyCode 为空");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
