/**
 * 服务入口：加载配置 -> 装配连接/自选/引擎 -> 起 HTTP ->（可选）自动跑一次回测。
 */

import "dotenv/config";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "./server/httpServer.js";
import { EngineController } from "./server/engineController.js";
import { ConnectionManager } from "./exchanges/connectionManager.js";
import { LlmManager } from "./llm/llmManager.js";
import { AuthService, loadAuthConfig } from "./auth/auth.js";
import { BotManager } from "./bots/botManager.js";
import { StrategyStore } from "./strategies/profileStore.js";
import { NewsService } from "./news/newsService.js";
import { EvolutionEngine } from "./evolution/engine.js";
import { toDigest } from "./news/types.js";
import { WatchlistManager } from "./watchlist.js";
import { loadYamlFile } from "./config.js";
import { buildConfig } from "./configSchema.js";
import { setLogLevel, getLogger } from "./core/logger.js";
import { readEnv } from "./env.js";

const log = getLogger("main");

async function main(): Promise<void> {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const configPath = readEnv("CONFIG") || join(root, "config", "default.yaml");
  const dataDir = readEnv("DATA_DIR") || join(root, "data");

  const config = buildConfig(loadYamlFile<Record<string, unknown>>(configPath));
  setLogLevel(config.app.logLevel);

  const connections = new ConnectionManager(dataDir);
  const watchlist = new WatchlistManager(dataDir);
  const auth = new AuthService(loadAuthConfig());
  if (auth.isRequired()) {
    log.warn("鉴权已启用：未认证的请求将被拒绝（用户名=%s）", config.auth.username || "仅 Token");
  }
  const llm = new LlmManager(dataDir, config.llm.strategy);
  seedLegacyLlmProfile(llm, config);
  const news = new NewsService(dataDir, config.news);
  const strategies = new StrategyStore(dataDir, {
    seed: {
      name: "默认策略",
      decisionSource: config.strategy.decisionSource,
      fastWindow: config.strategy.fastWindow,
      slowWindow: config.strategy.slowWindow,
      maxTargetWeight: config.strategy.maxTargetWeight,
      selfAllocating: config.strategy.selfAllocating,
      maxPositions: config.strategy.maxPositions,
      maxGrossExposure: config.strategy.maxGrossExposure,
      allocationInterval: config.strategy.allocationInterval,
      hybridInfluence: config.strategy.hybridInfluence,
      hybridAnalysisTtlMs: config.strategy.hybridAnalysisTtlMs,
    },
  });
  const evolution = new EvolutionEngine(dataDir, config, (next) => {
    // 自我进化的结论作用在运行配置上（默认不写回配置文件，页面可一键 persist）
    controller.applyConfig({ strategy: next.strategy, risk: next.risk });
    bots.useConfig(next);
    news.useConfig(next.news);
    llm.setStrategy(next.llm.strategy);
    log.info("自我进化已更新运行配置（下次运行生效）");
  });
  // 机器人也要留痕：否则"用了机器人"就等于关掉了自我进化
  const bots = new BotManager(dataDir, config, connections, llm, strategies, evolution, news);
  const controller = new EngineController(config, connections, watchlist, llm, news, evolution, strategies, {
    // 对照实验要能直接拿配置好的机器人当参赛者
    list: () => bots.list(),
    strategyOf: (bot) => bots.strategyOf(bot),
  });

  const app = createServer(controller, {
    connections,
    watchlist,
    llm,
    bots,
    news,
    evolution,
    auth,
    configPath,
    webDist: join(root, "web", "dist"),
  });
  await new Promise<void>((done) => app.listen(config.server.port, config.server.host, () => done()));
  log.info("%s 已启动 http://%s:%d", config.app.name, config.server.host, config.server.port);

  // 保证至少有一个可用连接，避免首屏空白。
  // 不往候选池里塞标的：模拟交易所的标的是它自带的（builtinSymbols），
  // 用户不需要也不能在候选池里配它 —— 行情本来就是它编的。
  if (connections.list().length === 0) {
    const created = connections.create({ adapterId: "simulated", label: "模拟交易所（默认）" });
    config.execution.connectionId = created.id;
    log.info("已初始化默认连接: %s（模拟交易所）", created.id);
  }
  dropBuiltinWatchlist(connections, watchlist);
  bots.normalizeBuiltinSymbols();
  await controller.refreshTickers().catch(() => undefined);

}

function dirname(p: string): string {
  return p.slice(0, p.lastIndexOf("/"));
}

/**
 * 清掉「自带标的的连接」在候选池里的遗留条目。
 *
 * 模拟交易所的标的由它自己定，候选池对它无效：之前存在这里的条目界面上既看不到、
 * 也用不上，留着只会让「候选池 N 个标的」这种数字对不上。删掉，并在日志里说清楚。
 */
function dropBuiltinWatchlist(connections: ConnectionManager, watchlist: WatchlistManager): void {
  for (const c of connections.list()) {
    let builtin: boolean;
    try {
      builtin = connections.adapter(c.id).meta.builtinSymbols === true;
    } catch {
      continue;
    }
    if (!builtin) continue;
    const stale = watchlist.list().filter((w) => w.connectionId === c.id);
    for (const w of stale) watchlist.remove(w.id);
    if (stale.length > 0) {
      log.info("连接 %s 自带标的，已从候选池移除 %d 个无效条目: %s", c.label, stale.length, stale.map((w) => w.symbol).join(","));
    }
  }
}

/**
 * 兼容旧的单实例配置：若尚无任何 LLM 配置，但配置文件里带了
 * base_url / model / OPENAI_API_KEY，则自动迁移为一个 LLM 实例。
 */
function seedLegacyLlmProfile(llm: LlmManager, config: ReturnType<typeof buildConfig>): void {
  if (llm.list().length > 0) return;
  if (!config.llm.apiKey) return;
  llm.create({
    label: `${config.llm.model}（由配置文件迁移）`,
    provider: config.llm.provider,
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    apiKey: config.llm.apiKey,
    temperature: config.llm.temperature,
    timeoutMs: config.llm.timeoutMs,
  });
  log.info("已从配置文件迁移 1 个 LLM 实例，可在「模型管理」页继续添加更多");
}

main().catch((err) => {
  log.error("服务异常退出: %s", (err as Error).stack ?? err);
  process.exit(1);
});