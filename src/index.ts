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
import { AuthService } from "./auth/auth.js";
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
  // 鉴权：密码哈希存 data/auth.json；没设 = 免登录。
  const auth = new AuthService(dataDir);
  if (auth.hasPassword()) {
    log.warn("面板密码已启用：未认证的请求将被拒绝");
  }
  const llm = new LlmManager(dataDir, config.llm.strategy);
  seedLegacyLlmProfile(llm, config);
  const news = new NewsService(dataDir, config.news);
  const strategies = new StrategyStore(dataDir, {
    seedPresets: true,
    seed: {
      name: "默认策略",
      decisionSource: config.strategy.decisionSource,
      engine: config.strategy.engine,
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

  // 模拟交易所已下线（一切以实盘数据为准），不再自动创建默认连接：
  // 首次使用请到「交易所连接」页自选一家 —— 公共行情（Binance/Gate/OKX/Stooq）
  // 全部无需密钥，界面会引导走完这一步。
  bots.normalizeBuiltinSymbols();
  await controller.refreshTickers().catch(() => undefined);

  // 容器长期运行时，进程/容器重启后自动恢复启用的机器人（默认关闭，显式 AAAAI_AUTOSTART=1 才开）
  const autostart = readEnv("AUTOSTART").trim().toLowerCase();
  if (autostart === "1" || autostart === "true" || autostart === "yes") {
    const states = await bots.startEnabled();
    const running = states.filter((s) => s.status === "running").length;
    log.info("AAAAI_AUTOSTART：已启动 %d/%d 个机器人", running, states.length);
  }
}

function dirname(p: string): string {
  return p.slice(0, p.lastIndexOf("/"));
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