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
import { BotManager } from "../src/bots/botManager.js";
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

test("机器人: 连接不存在 / 没选标的 时给出明确错误", () => {
  const dir = tmpDataDir();
  try {
    const cm = new ConnectionManager(dir);
    const bots = new BotManager(dir, testConfig(), cm, new LlmManager(dir));
    // 原来这些校验挂在单账户引擎上，引擎删除后由机器人自己把关
    assert.throws(() => bots.create({ name: "X", connectionId: "不存在的连接", symbols: ["DEMO-BTC"] }), /连接不存在/);
    const conn = cm.create({ adapterId: "simulated", label: "模拟" });
    assert.throws(() => bots.create({ name: "X", connectionId: conn.id, symbols: [] }), /请至少选择一个标的/);
    assert.throws(() => bots.create({ name: "", connectionId: conn.id, symbols: ["DEMO-BTC"] }), /请填写机器人名称/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("机器人: 回测跑完后状态完整（引擎删除后，运行数据都来自这里）", async () => {
  const dir = tmpDataDir();
  try {
    const cm = new ConnectionManager(dir);
    const conn = cm.create({ adapterId: "simulated", label: "模拟" });
    const wm = new WatchlistManager(dir);
    wm.add({ symbol: "DEMO-BTC", name: "模拟比特币", assetClass: "crypto", currency: "USDT", connectionId: conn.id });
    const bots = new BotManager(dir, testConfig(), cm, new LlmManager(dir));
    const bot = bots.create({ name: "回测", connectionId: conn.id, symbols: ["DEMO-BTC"], mode: "backtest", barCount: 60 });
    const st = await bots.start(bot.id);

    assert.equal(st.status, "stopped");
    assert.ok(st.metrics, "应产出指标");
    assert.ok(st.metrics!.finalEquity > 0);
    assert.ok(st.equityCurve.length > 1, "应产出权益曲线（仪表盘靠它画图）");
    assert.ok(st.bars > 0);
    assert.equal(st.liveTrading, false, "回测永远不是实盘");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EngineController: 已删除单账户运行接口（防止又长回来两条并行路径）", () => {
  const dir = tmpDataDir();
  try {
    const cm = new ConnectionManager(dir);
    const real = new EngineController(testConfig(), cm, new WatchlistManager(dir), new LlmManager(dir));
    const controller = real as unknown as Record<string, unknown>;
    for (const gone of ["start", "stop", "runBacktest", "runLive"]) {
      assert.equal(gone in controller, false, `controller.${gone} 应不存在 —— 交易只有机器人这一条路径`);
    }
    const snap = real.snapshot() as unknown as Record<string, unknown>;
    for (const gone of ["status", "mode", "metrics", "equityCurve", "positions", "trades", "broker"]) {
      assert.equal(gone in snap, false, `全局状态不应再有 ${gone}（那是单机运行的数据）`);
    }
    assert.ok("tickers" in snap && "comparison" in snap && "config" in snap, "全局状态只保留行情、对照与配置");
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