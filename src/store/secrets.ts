/**
 * 密钥存储：统一管理 data/secrets.json（0600 权限，已 gitignore）。
 * 交易所连接与 LLM 配置共用；按前缀命名空间隔离。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../core/logger.js";

const log = getLogger("secrets");

export interface SecretRecord {
  apiKey: string;
  apiSecret: string;
}

export class SecretStore {
  private cache = new Map<string, SecretRecord>();
  private readonly path: string;

  constructor(private readonly dataDir: string) {
    this.path = join(dataDir, "secrets.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, SecretRecord>;
      this.cache = new Map(Object.entries(raw));
    } catch (err) {
      log.warn("secrets.json 解析失败，密钥需重新填写: %s", (err as Error).message);
    }
  }

  private persist(): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.cache), null, 2), { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  /** 读取密钥；不存在返回空记录。 */
  get(key: string): SecretRecord {
    return this.cache.get(key) ?? { apiKey: "", apiSecret: "" };
  }

  /** 写入密钥（整体覆盖）。 */
  set(key: string, record: SecretRecord): void {
    this.cache.set(key, record);
    this.persist();
  }

  /** 部分更新：空字符串视为「保持不变」。 */
  patch(key: string, patch: Partial<SecretRecord>): SecretRecord {
    const current = this.get(key);
    const next: SecretRecord = {
      apiKey: patch.apiKey ? patch.apiKey : current.apiKey,
      apiSecret: patch.apiSecret ? patch.apiSecret : current.apiSecret,
    };
    this.set(key, next);
    return next;
  }

  delete(key: string): void {
    if (this.cache.delete(key)) this.persist();
  }

  hasKey(key: string, field: "apiKey" | "apiSecret" = "apiKey"): boolean {
    return Boolean(this.get(key)[field]);
  }

  /** 命名空间：同一 id 在不同业务域下互不覆盖。 */
  namespace(scope: string): (id: string) => string {
    return (id: string) => `${scope}:${id}`;
  }
}