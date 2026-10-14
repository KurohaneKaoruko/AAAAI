/**
 * 服务入口：加载配置 -> 建引擎 -> 起 HTTP 服务 ->（可选）自动跑一次回测。
 */

import "dotenv/config";
import { createServer } from "./server/httpServer.js";
import { EngineController } from "./server/engineController.js";
import { loadYamlFile } from "./config.js";
import { buildConfig } from "./configSchema.js";
import { setLogLevel, getLogger } from "./core/logger.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const log = getLogger("main");

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..");
  const configPath = process.env.AAAAAI_CONFIG ?? join(root, "config", "default.yaml");

  const raw = loadYamlFile<Record<string, unknown>>(configPath);
  const config = buildConfig(raw);
  setLogLevel(config.app.logLevel);

  const controller = new EngineController(config);
  const app = createServer(controller, { webDist: join(root, "web", "dist") });

  await new Promise<void>((resolvePromise) => {
    app.listen(config.server.port, config.server.host, () => resolvePromise());
  });
  log.info("%s 已启动 http://%s:%d", config.app.name, config.server.host, config.server.port);

  // 默认自动跑一次回测，让 WebUI 一打开就有内容；AAAAI_AUTOSTART=0 关闭
  if (process.env.AAAAAI_AUTOSTART !== "0") {
    try {
      await controller.start("backtest");
      log.info("启动回测完成: %o", controller.snapshot().metrics);
    } catch (err) {
      log.error("启动回测失败: %s", (err as Error).message);
    }
  }
}

main().catch((err) => {
  log.error("服务异常退出: %s", (err as Error).stack ?? err);
  process.exit(1);
});
