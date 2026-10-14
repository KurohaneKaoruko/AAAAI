/**
 * 配置加载：YAML 文件 + 环境变量覆盖 + 安全取值。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import type { AppConfig } from "./configSchema.js";

export type { AppConfig };

/** 读取 YAML 配置为原始对象。 */
export function loadYamlFile<T = Record<string, unknown>>(path: string): T {
  const text = readFileSync(resolve(path), "utf8");
  return (loadYaml(text) ?? {}) as T;
}

/** 安全读取嵌套配置：dig(cfg, "risk", "fee_rate", default=0.0)。 */
export function dig(
  config: Record<string, unknown>,
  ...path: [...keys: string[], fallback: unknown]
): unknown {
  const keys = path.slice(0, -1) as string[];
  const fallback = path[path.length - 1];
  let node: unknown = config;
  for (const key of keys) {
    if (typeof node !== "object" || node === null || !(key in node)) return fallback;
    node = (node as Record<string, unknown>)[key];
  }
  return node === undefined ? fallback : node;
}

/** 数值型取值：非数值/缺失时回落默认值。 */
export function num(
  config: Record<string, unknown>,
  path: string[],
  fallback: number,
): number {
  const raw = dig(config, ...path, fallback);
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 字符串型取值。 */
export function str(
  config: Record<string, unknown>,
  path: string[],
  fallback: string,
): string {
  const raw = dig(config, ...path, fallback);
  return typeof raw === "string" && raw.length > 0 ? raw : fallback;
}

/** 布尔型取值。 */
export function bool(
  config: Record<string, unknown>,
  path: string[],
  fallback: boolean,
): boolean {
  const raw = dig(config, ...path, fallback);
  return typeof raw === "boolean" ? raw : fallback;
}

/** 从环境变量读取字符串（用于 API Key 等敏感配置）。 */
export function fromEnv(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}
