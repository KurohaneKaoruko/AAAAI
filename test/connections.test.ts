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
    wm.add({ symbol: "仓位1", name: "模拟比特币", assetClass: "crypto", currency: "USDT", connectionId: "c1" });
    assert.throws(
      () => wm.add({ symbol: "仓位1", name: "x", assetClass: "crypto", currency: "USDT", connectionId: "c1" }),
      /已在自选列表中/,
    );
    wm.add({ symbol: "600519", name: "茅台", assetClass: "stock", currency: "CNY", connectionId: "c1" });
    assert.equal(wm.list().length, 2);
    assert.equal(wm.has("c1", "仓位1"), true);
    assert.equal(wm.has("c2", "仓位1"), false, "按连接隔离");

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
    assert.throws(() => bots.create({ name: "X", connectionId: "不存在的连接", symbols: ["仓位1"] }), /连接不存在/);
    // 模拟交易所自带标的：不传标的照样能建（这个交易所没有"挑标的"这回事）
    const conn = cm.create({ adapterId: "simulated", label: "模拟" });
    const auto = bots.create({ name: "自带标的", connectionId: conn.id, symbols: [] });
    assert.ok(auto.symbols.length > 0, "模拟交易所应自带标的");
    // 真实交易所没有自带标的：必须自己选
    const real = cm.create({ adapterId: "binance", label: "币安" });
    assert.throws(
      () => bots.create({ name: "X", connectionId: real.id, symbols: [] }),
      /请至少选择一个标的/,
    );
    assert.throws(() => bots.create({ name: "", connectionId: conn.id, symbols: ["仓位1"] }), /请填写机器人名称/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("机器人: 实时运行状态完整（引擎删除后，运行数据都来自这里）", async () => {
  const dir = tmpDataDir();
  try {
    const cm = new ConnectionManager(dir);
    const conn = cm.create({ adapterId: "simulated", label: "模拟" });
    const wm = new WatchlistManager(dir);
    wm.add({ symbol: "仓位1", name: "模拟比特币", assetClass: "crypto", currency: "USDT", connectionId: conn.id });
    const bots = new BotManager(dir, testConfig(), cm, new LlmManager(dir));
    const bot = bots.create({ name: "实时", connectionId: conn.id, symbols: ["仓位1"], barCount: 60, pollMs: 100 });
    const st = await bots.start(bot.id);

    // 机器人只有实时一种跑法：预热喂指标，成交随实时 K 线产生
    assert.equal(st.status, "running");
    assert.equal(st.bars, 0, "实时 bars 从 0 开始");
    assert.ok(st.warmupBars > 0, "预热历史 K 线已就绪");
    assert.equal(st.trades.length, 0, "预热不产生成交");
    assert.equal(st.liveTrading, false, "默认模拟成交不是实盘");
    assert.ok(st.metrics, "应产出指标");
    assert.ok(st.metrics!.finalEquity > 0);

    // 等第一根实时 K 线带来成交，权益曲线才有内容（仪表盘靠它画图）
    const deadline = Date.now() + 15000;
    while ((bots.state(bot.id).metrics?.totalFills ?? 0) === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const st2 = bots.state(bot.id);
    assert.ok((st2.metrics?.totalFills ?? 0) > 0, "实时 K 线到来后应产生成交");
    assert.ok(st2.equityCurve.length > 0, "应有权益曲线");
    assert.ok(st2.bars > 0, "实时 bars 应推进");
    bots.stop(bot.id);
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
test("模拟交易所自带标的：候选池空着也能开跑", async () => {
  const dir = tmpDataDir();
  try {
    const cm = new ConnectionManager(dir);
    const conn = cm.create({ adapterId: "simulated", label: "模拟" });
    // 候选池空 + 配置里也没有全局标的：模拟交易所不该因此跑不起来
    const config = testConfig();
    config.market = { ...config.market, symbols: [] };
    const controller = new EngineController(config, cm, new WatchlistManager(dir), new LlmManager(dir));

    const target = controller.resolveRunTarget();
    assert.equal(target.connection.id, conn.id);
    assert.ok(target.symbols.length > 0, "模拟交易所应自带标的");
    const state = controller.snapshot();
    assert.equal(state.runTarget.error, null, "候选池空不该成为「跑不了」的理由");
    assert.equal(state.runTarget.symbolsBuiltIn, true, "界面据此不再要求挑标的");

    // 但它不进「候选池行情」：模拟品种是编出来的，没有报价可看，
    // 拿它们当行情列出来，看着就像真有一批标的在报数。
    assert.deepEqual(await controller.refreshTickers(), [], "自带标的的连接不发行情");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("候选池行情只按候选池取，并带上是哪个连接的", async () => {
  const dir = tmpDataDir();
  try {
    const cm = new ConnectionManager(dir);
    const conn = cm.create({ adapterId: "simulated", label: "模拟" });
    const watchlist = new WatchlistManager(dir);
    // 模拟连接的行情由它自己编，这里只是借它验证"按候选池取行情 + 带上连接"这条链路
    watchlist.add({ connectionId: conn.id, symbol: "仓位1", name: "模拟品种", assetClass: "crypto", currency: "USDT" });
    const controller = new EngineController(testConfig(), cm, watchlist, new LlmManager(dir));

    const tickers = await controller.refreshTickers();
    assert.equal(tickers.length, 1);
    assert.equal(tickers[0]!.symbol, "仓位1");
    assert.equal(tickers[0]!.connectionId, conn.id, "界面按 connectionId 分开显示");
    assert.equal(controller.snapshot().tickers.length, 1, "快照里也要带上");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("真实交易所没有自带标的：候选池空就明确报错，不假装能跑", () => {
  const dir = tmpDataDir();
  try {
    const cm = new ConnectionManager(dir);
    const binance = cm.create({ adapterId: "binance", label: "币安" });
    const config = testConfig();
    config.market = { ...config.market, symbols: [] };
    const controller = new EngineController(config, cm, new WatchlistManager(dir), new LlmManager(dir));

    const state = controller.snapshot();
    assert.equal(state.runTarget.symbolsBuiltIn, false);
    assert.match(state.runTarget.error ?? "", /没有可运行的标的/, "要说出为什么跑不了");
    assert.equal(state.runTarget.connectionId, null);
    assert.equal(binance.adapterId, "binance");
    assert.throws(() => controller.resolveRunTarget(), /没有可运行的标的/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("自带标的的连接：机器人的标的被拉齐到自带清单（不留隐藏配置）", () => {
  const dir = tmpDataDir();
  try {
    const cm = new ConnectionManager(dir);
    const conn = cm.create({ adapterId: "simulated", label: "模拟" });
    const bots = new BotManager(dir, testConfig(), cm, new LlmManager(dir));
    // 模拟交易所的标的由它自带：界面上没有"挑标的"这一步，
    // 所以老机器人存着的那套必须收敛掉，否则就是一份谁也改不到的隐藏配置
    const sim = bots.create({ name: "老模拟机器人", connectionId: conn.id, symbols: ["仓位1"] });
    // 真实交易所的机器人不该被动：那边的标的确实是用户选的
    const real = cm.create({ adapterId: "binance", label: "币安" });
    const realBot = bots.create({ name: "真实交易所机器人", connectionId: real.id, symbols: ["BTCUSDT"] });

    bots.normalizeBuiltinSymbols();

    const expected = (cm.adapter(conn.id).meta.defaultSymbols ?? []).map((s) => s.symbol);
    assert.ok(expected.length > 0, "模拟交易所必须自带标的清单");
    assert.deepEqual(bots.get(sim.id)!.symbols, expected);
    assert.deepEqual(bots.get(realBot.id)!.symbols, ["BTCUSDT"], "真实交易所的标的不能被改掉");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("运行目标是派生值：连接后加的，界面也不能一直说跑不了", () => {
  const dir = tmpDataDir();
  try {
    // 首次启动的次序就是这样：控制器先建好，默认连接随后才创建。
    // 运行目标要是存下来的，界面就会永远停在"尚未配置任何交易所连接"。
    const cm = new ConnectionManager(dir);
    const controller = new EngineController(testConfig(), cm, new WatchlistManager(dir), new LlmManager(dir));
    assert.match(controller.snapshot().runTarget.error ?? "", /尚未配置任何交易所连接/);

    const conn = cm.create({ adapterId: "simulated", label: "模拟" });
    const target = controller.snapshot().runTarget;
    assert.equal(target.connectionId, conn.id);
    assert.equal(target.error, null);
    assert.ok(target.symbols.length > 0, "自带标的的连接应解析出标的");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
