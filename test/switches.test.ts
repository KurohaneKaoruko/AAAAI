/**
 * 配置开关「说了就要做」：逐个验证审计里发现的死开关。
 *
 * 审计结论（修复前）：
 * - llm.enabled 从未被读取 → 关掉也没用，模型照用
 * - news.includeInAnalysis 从未被读取 → 面板上有真实开关，勾了毫无反应
 * - evolution.persist 从未挡写入 → 说「不持久化」却照写文件
 * - execution.apiKey/apiSecret/baseUrl 从未被读取（凭证在连接里），却出现在配置页上
 *
 * 每个用例都用「可观测行为」判定，而不是看字段存不存在。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineController } from "../src/server/engineController.js";
import { ConnectionManager } from "../src/exchanges/connectionManager.js";
import { WatchlistManager } from "../src/watchlist.js";
import { LlmManager } from "../src/llm/llmManager.js";
import { NewsService } from "../src/news/newsService.js";
import { testConfig } from "./helpers.js";
import { buildConfig, type AppConfig } from "../src/configSchema.js";
import type { NewsItem } from "../src/news/types.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "aaaaai-switch-"));
}

/** 造一条新闻（内容不重要，能被识别即可）。 */
function newsItem(symbol: string, title: string): NewsItem {
  return {
    id: `${symbol}-${title}`,
    symbol,
    title,
    summary: title,
    url: "https://example.com/a",
    source: "test",
    publishedAt: new Date().toISOString(),
    sentiment: 0.5,
    sentimentLabel: "positive",
    unverified: true,
  } as NewsItem;
}

function controllerWith(dir: string, config: AppConfig, items: NewsItem[]) {
  const cm = new ConnectionManager(dir);
  cm.create({ adapterId: "simulated", label: "模拟" });
  const wm = new WatchlistManager(dir);
  const llm = new LlmManager(dir);
  const news = new NewsService(dir, config.news);
  // 直接塞入内存，避免测试去打真实 RSS
  (news as unknown as { items: NewsItem[] }).items = items;
  const controller = new EngineController(config, cm, wm, llm, news);
  return { controller, cm, wm };
}

test("开关：news.includeInAnalysis 真的控制新闻是否进 prompt", async () => {
  const dir = tmpDir();
  try {
    const base = testConfig();
    const items = [newsItem("DEMO-BTC", "BTC 大涨")];

    // 开：注入新闻
    const on = controllerWith(dir, { ...base, news: { ...base.news, enabled: true, includeInAnalysis: true } }, items);
    const onDigest = await (on.controller as unknown as { newsFetcher: () => Promise<unknown[]> }).newsFetcher()(["DEMO-BTC"]);
    assert.equal(onDigest.length, 1, "includeInAnalysis=true 时应注入新闻");
    assert.equal((onDigest[0] as { symbol: string }).symbol, "DEMO-BTC");

    // 关：不注入，而且连取数都不做
    const off = controllerWith(dir, { ...base, news: { ...base.news, enabled: true, includeInAnalysis: false } }, items);
    const offDigest = await (off.controller as unknown as { newsFetcher: () => Promise<unknown[]> }).newsFetcher()(["DEMO-BTC"]);
    assert.deepEqual(offDigest, [], "includeInAnalysis=false 时不应注入新闻");

    // 总开关关：同样不注入
    const disabled = controllerWith(dir, { ...base, news: { ...base.news, enabled: false, includeInAnalysis: true } }, items);
    const disabledDigest = await (disabled.controller as unknown as { newsFetcher: () => Promise<unknown[]> }).newsFetcher()(["DEMO-BTC"]);
    assert.deepEqual(disabledDigest, [], "news.enabled=false 时不应注入新闻");

    // 运行时改配置即可生效（不需要重启引擎）
    const live = controllerWith(dir, { ...base, news: { ...base.news, enabled: true, includeInAnalysis: false } }, items);
    const fetcher = (live.controller as unknown as { newsFetcher: () => (s: string[]) => Promise<unknown[]> }).newsFetcher();
    assert.deepEqual(await fetcher(["DEMO-BTC"]), [], "初始为关");
    live.controller.applyConfig({ news: { ...base.news, enabled: true, includeInAnalysis: true } });
    assert.equal((await fetcher(["DEMO-BTC"])).length, 1, "改完配置后立即生效");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 起一个假的 OpenAI 兼容服务，记录收到的请求数。 */
async function fakeModel(): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits += 1;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "fake",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: '{"target_weight":0.4,"confidence":0.6,"reason":"fake"}',
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    hits: () => hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("开关：是否请求模型只由 decision_source 决定（rules 时一次都不发）", async () => {
  const dir = tmpDir();
  const model = await fakeModel();
  try {
    const base = testConfig();
    const run = async (source: "rules" | "chat") => {
      const cfg: AppConfig = {
        ...base,
        llm: { ...base.llm, decisionInterval: 1 },
        strategy: { ...base.strategy, decisionSource: source },
        market: { ...base.market, barCount: 40, symbols: ["DEMO-BTC"] },
        risk: { ...base.risk, maxDrawdownPct: 0.9 },
      };
      const { controller, cm } = controllerWith(dir, cfg, []);
      controller["llm"].create({
        label: "fake",
        kind: "chat",
        baseUrl: model.url,
        model: "fake",
        apiKey: "sk-test",
      });
      await controller.start({ mode: "backtest", bars: 40, interval: "1m", connectionId: cm.list()[0]!.id });
      const state = controller.snapshot();
      return { strategy: state.strategy, error: state.error };
    };

    const before = model.hits();
    const on = await run("chat");
    assert.ok(model.hits() > before, "decision_source=chat 时应真的请求模型");
    assert.equal(on.strategy, "llm-momentum", "chat 应走模型策略");
    assert.equal(on.error, null);

    const mid = model.hits();
    const off = await run("rules");
    assert.equal(model.hits(), mid, "decision_source=rules 时不得发出任何模型请求");
    assert.equal(off.strategy, "momentum", "rules 应走纯规则策略");
    assert.equal(off.error, null);
  } finally {
    await model.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("开关：配置里不再有 llm.enabled 这种改了也没用的字段", () => {
  const cfg = testConfig();
  const llm = cfg.llm as unknown as Record<string, unknown>;
  assert.equal("enabled" in llm, false, "llm.enabled 从未被读取过，已删除（否则两个开关会互相打架）");
  // 唯一的事实来源
  assert.equal(typeof cfg.strategy.decisionSource, "string");
});

test("开关：execution 段不再暴露从不生效的下单凭证字段", () => {
  const cfg = testConfig();
  const exec = cfg.execution as unknown as Record<string, unknown>;
  for (const dead of ["apiKey", "apiSecret", "baseUrl"]) {
    assert.equal(dead in exec, false, `execution.${dead} 从未被读取，应删除而不是留一个假开关`);
  }
  // 保留下来的字段是真在用的
  assert.equal(typeof exec.mode, "string");
  assert.equal(typeof exec.connectionId, "string");
  assert.equal(typeof exec.slicingAlgo, "string");
});
test("开关：配置报告的鉴权状态必须与真正生效的一致", () => {
  const base = testConfig();

  // 1) 什么都不设：配置必须说「未启用」
  const none = buildConfig({});
  assert.equal(none.auth.enabled, false, "无环境变量时不应显示已启用");

  // 2) 只设用户名没设密码：AuthService 判定为「未启用」，
  //    配置必须跟着说未启用 —— 以前这里是 || AUTH_USERNAME，会报成已启用。
  const userOnly = buildConfig({}, { AAAAI_AUTH_USERNAME: "admin" });
  assert.equal(userOnly.auth.enabled, false, "只有用户名、没有密码或 token 时不得显示已启用");

  // 3) 用户名 + 密码：两者齐备才启用
  const both = buildConfig({}, { AAAAI_AUTH_USERNAME: "admin", AAAAI_AUTH_PASSWORD: "pw" });
  assert.equal(both.auth.enabled, true, "用户名+密码齐备应显示已启用");
  assert.equal(both.auth.username, "admin");

  // 4) YAML 里写 enabled: true 也不能凭空开启（配置不是事实来源）
  const yamlOnly = buildConfig({ auth: { enabled: true, username: "ghost", session_ttl_hours: 99 } });
  assert.equal(yamlOnly.auth.enabled, false, "YAML 不得单独把鉴权打开");
  assert.equal(yamlOnly.auth.sessionTtlHours, 12, "YAML 里的会话时长也不再生效");

  // 5) 会话时长由环境变量决定
  const ttl = buildConfig({}, { AAAAI_AUTH_TOKEN: "t", AAAAI_AUTH_SESSION_HOURS: "3" });
  assert.equal(ttl.auth.sessionTtlHours, 3);

  // 6) 运行中改配置也不能篡改这个只读视图
  assert.equal(base.auth.enabled, false);
});
