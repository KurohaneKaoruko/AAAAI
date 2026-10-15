/**
 * 环境变量命名规则。
 *
 * 项目名 AAAAI = Ai / Agent / Auto / Asset / Investment 的首字母，
 * 即「4 个 A + 1 个 I」。这里集中定义一次，其余代码不再手写。
 *
 * 规则（只对 AAAAI 自己的配置项加前缀）：
 *
 * 1. 应用自有开关 —— 加前缀，避免与宿主机其它程序撞名：
 *      AAAAI_CONFIG / AAAAI_DATA_DIR / AAAAI_AUTOSTART / AAAAI_AUTH_*
 * 2. 第三方生态变量 —— 保持标准名，绝不加前缀：
 *      OPENAI_API_KEY、BINANCE_API_KEY、BINANCE_API_SECRET、DEEPSEEK_API_KEY ...
 *    这些是各家文档与 CI 约定的名字，加了前缀就与生态脱节。
 *      （LLM 密钥变量名由配置项 llm.api_key_env 指定，默认 OPENAI_API_KEY）
 */

export const ENV_PREFIX = "AAAAI";

/** AAAAI 自有配置项：拼接带前缀的名字。 */
export function envKey(name: string): string {
  return `${ENV_PREFIX}_${name}`;
}

/**
 * 读取 AAAAI 自有配置项（带前缀）。
 * 注意：未设置时返回空字符串（不是 undefined），因此调用方请用 `||` 或显式判空，
 * 不要用 `??`，否则会拿到空串而不是默认值。
 */
export function readEnv(name: string, fallback = ""): string {
  return process.env[envKey(name)] ?? fallback;
}

/** 读取第三方生态变量（原名，不加前缀）。 */
export function readRawEnv(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

/** 判断一个变量名是否为 AAAAI 自有配置项（带前缀）。 */
export function isOwnEnv(name: string): boolean {
  return name.startsWith(`${ENV_PREFIX}_`);
}