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
  const controller = new EngineController(config, connections, watchlist, llm);

  const app = createServer(controller, {
    connections,
    watchlist,
    llm,
    auth,
    configPath,
    webDist: join(root, "web", "dist"),
  });
  await new Promise<void>((done) => app.listen(config.server.port, config.server.host, () => done()));
  log.info("%s 已启动 http://%s:%d", config.app.name, config.server.host, config.server.port);

  // 保证至少有一个可用连接与默认标的，避免首屏空白
  if (connections.list().length === 0) {
    const created = connections.create({ adapterId: "simulated", label: "模拟交易所（默认）" });
    watchlist.add({
      symbol: "DEMO-BTC",
      name: "模拟比特币",
      assetClass: "crypto",
      currency: "USDT",
      connectionId: created.id,
    });
    config.execution.connectionId = created.id;
    log.info("已初始化默认连接: %s（模拟交易所）", created.id);
  }
  await controller.refreshTickers().catch(() => undefined);

  if (readEnv("AUTOSTART") === "1") {
    try {
      await controller.start({ mode: "backtest" });
      log.info("启动回测完成: %o", controller.snapshot().metrics);
    } catch (err) {
      log.warn("启动回测失败: %s", (err as Error).message);
    }
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
  log.info("已从配置文件迁移 1 个 LLM 实例，可在「LLM 大模型」页继续添加更多");
}

main().catch((err) => {
  log.error("服务异常退出: %s", (err as Error).stack ?? err);
  process.exit(1);
});