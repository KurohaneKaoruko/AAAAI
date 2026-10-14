import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionManager } from "../src/exchanges/connectionManager.js";
import { WatchlistManager } from "../src/watchlist.js";
import { SimulatedAdapter } from "../src/exchanges/simulated.js";
import { EngineController } from "../src/server/engineController.js";
import { LlmManager } from "../src/llm/llmManager.js";
import { testConfig } from "./helpers.js";

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "aaaaai-"));
}

test("ConnectionManager: 增删改查与密钥脱敏", () => {
  const dir = tmpDataDir();
  try {
    const cm = new ConnectionManager(dir);
    const created = cm.create({ adapterId: "binance", label: "币安主", testnet: true, apiKey: "K1", apiSecret: "S1" });
    assert.equal(created.adapterId, "binance");
    assert.equal(created.hasKey, true);
    assert.equal(created.hasSecret, true);
    assert.equal(JSON.stringify(cm.list()).includes("S1"), false, "视图不得泄露密钥");

    const updated = cm.update(created.id, { label: "币安改名" });
    assert.equal(updated.label, "币安改名");
    assert.equal(updated.hasKey, true, "更新不应清空已有密钥");

    // 空值不覆盖
    cm.update(created.id, { apiKey: "" });
    assert.equal(cm.get(created.id) && cm.adapter(created.id).meta.id, "binance");

    cm.remove(created.id);
    assert.equal(cm.list().length, 0);
    assert.throws(() => cm.adapter(created.id), /连接不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConnectionManager: 持久化后可重新加载", () => {
  const dir = tmpDataDir();
  try {
    const cm1 = new ConnectionManager(dir);
    const conn = cm1.create({ adapterId: "simulated", label: "模拟" });
    const cm2 = new ConnectionManager(dir);
    assert.equal(cm2.list().length, 1);
    assert.equal(cm2.list()[0]!.id, conn.id);
    assert.ok(cm2.adapter(conn.id) instanceof SimulatedAdapter);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConnectionManager: 未知适配器被拒绝", () => {
  const dir = tmpDataDir();
  try {
    const cm = new ConnectionManager(dir);
    assert.throws(() => cm.create({ adapterId: "kraken-nope", label: "x" }), /未知的交易所适配器/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WatchlistManager: 添加/去重/删除/持久化", () => {
  const dir = tmpDataDir();
  try {
    const wm = new WatchlistManager(dir);
    wm.add({ symbol: "DEMO-BTC", name: "模拟比特币", assetClass: "crypto", currency: "USDT", connectionId: "c1" });
    assert.throws(
      () => wm.add({ symbol: "DEMO-BTC", name: "x", assetClass: "crypto", currency: "USDT", connectionId: "c1" }),
      /已在自选列表中/,
    );
    wm.add({ symbol: "600519", name: "茅台", assetClass: "stock", currency: "CNY", connectionId: "c1" });
    assert.equal(wm.list().length, 2);
    assert.equal(wm.has("c1", "DEMO-BTC"), true);
    assert.equal(wm.has("c2", "DEMO-BTC"), false, "按连接隔离");

    const reloaded = new WatchlistManager(dir);
    assert.equal(reloaded.list().length, 2);

    reloaded.remove(reloaded.list()[0]!.id);
    assert.equal(reloaded.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EngineController: 无连接时给出明确错误", async () => {
  const dir = tmpDataDir();
  try {
    const cm = new ConnectionManager(dir);
    const wm = new WatchlistManager(dir);
    const controller = new EngineController(testConfig(), cm, wm, new LlmManager(dir));
    await assert.rejects(() => controller.start({ mode: "backtest" }), /尚未配置任何交易所连接/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EngineController: 无标的时给出明确错误", async () => {
  const dir = tmpDataDir();
  try {
    const cm = new ConnectionManager(dir);
    cm.create({ adapterId: "simulated", label: "模拟" });
    const wm = new WatchlistManager(dir);
    // 自选与配置都为空 -> 必须给出可读错误
    const empty = testConfig();
    empty.market.symbols = [];
    const controller = new EngineController(empty, cm, wm, new LlmManager(dir));
    await assert.rejects(() => controller.start({ mode: "backtest" }), /没有可运行的标的/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EngineController: 回测完成后状态完整", async () => {
  const dir = tmpDataDir();
  try {
    const cm = new ConnectionManager(dir);
    const conn = cm.create({ adapterId: "simulated", label: "模拟" });
    const wm = new WatchlistManager(dir);
    wm.add({ symbol: "DEMO-BTC", name: "模拟比特币", assetClass: "crypto", currency: "USDT", connectionId: conn.id });
    const controller = new EngineController(testConfig(), cm, wm, new LlmManager(dir));

    await controller.start({ mode: "backtest", bars: 60 });

    const state = controller.snapshot();
    assert.equal(state.status, "stopped");
    assert.equal(state.mode, "backtest");
    assert.deepEqual(state.symbols, ["DEMO-BTC"]);
    assert.equal(state.connectionLabel, "模拟");
    assert.ok(state.metrics);
    assert.equal(state.metrics!.equityPoints, 60);
    assert.ok(state.events.length > 0);
    assert.ok(state.equityCurve.length === 60);
    assert.ok(["paper", "exchange"].includes(state.broker!.name));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EngineController: 配置热更新（部分字段合并）", () => {
  const dir = tmpDataDir();
  try {
    const cm = new ConnectionManager(dir);
    const controller = new EngineController(testConfig(), cm, new WatchlistManager(dir), new LlmManager(dir));
    const before = controller.getConfig();
    controller.applyConfig({ risk: { ...before.risk, initialCash: 55555 } });
    const after = controller.getConfig();
    assert.equal(after.risk.initialCash, 55555);
    assert.equal(after.risk.feeRate, before.risk.feeRate, "未提及字段应保留");
    assert.equal(after.strategy.fastWindow, before.strategy.fastWindow);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});