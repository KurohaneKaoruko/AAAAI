/**
 * 连接管理：交易所连接的 CRUD、密钥保管与连接测试。
 *
 * 持久化策略：
 * - data/connections.json 保存连接元信息（不含密钥，可安全提交）
 * - data/secrets.json 保存密钥（0600 权限，data/ 已在 .gitignore）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAdapter, getAdapterMeta, UnsupportedAdapterError } from "./registry.js";
import type { AdapterMeta, Connection, ConnectionTest, ExchangeAdapter } from "./types.js";
import { getLogger } from "../core/logger.js";
import { redactConfig } from "../configSchema.js";

const log = getLogger("connections");

export interface ConnectionInput {
  adapterId: string;
  label: string;
  testnet?: boolean;
  apiKey?: string;
  apiSecret?: string;
}

/** 对外暴露的连接视图（密钥脱敏）。 */
export interface ConnectionView extends Connection {
  hasKey: boolean;
  hasSecret: boolean;
  adapter: AdapterMeta;
}

export class ConnectionManager {
  private connections: Connection[] = [];
  private secrets = new Map<string, { apiKey: string; apiSecret: string }>();
  private adapters = new Map<string, ExchangeAdapter>();

  constructor(private readonly dataDir: string) {
    this.load();
  }

  // ---------- 持久化 ----------

  private get metaPath(): string {
    return join(this.dataDir, "connections.json");
  }

  private get secretPath(): string {
    return join(this.dataDir, "secrets.json");
  }

  private load(): void {
    if (existsSync(this.metaPath)) {
      try {
        this.connections = JSON.parse(readFileSync(this.metaPath, "utf8")) as Connection[];
      } catch (err) {
        log.warn("connections.json 解析失败，使用空列表: %s", (err as Error).message);
        this.connections = [];
      }
    }
    if (existsSync(this.secretPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.secretPath, "utf8")) as Record<
          string,
          { apiKey: string; apiSecret: string }
        >;
        this.secrets = new Map(Object.entries(raw));
      } catch {
        log.warn("secrets.json 解析失败，密钥需重新填写");
      }
    }
  }

  private persist(): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.metaPath, JSON.stringify(this.connections, null, 2), { mode: 0o600 });
    const secretObj = Object.fromEntries(this.secrets);
    writeFileSync(this.secretPath, JSON.stringify(secretObj, null, 2), { mode: 0o600 });
    chmodSync(this.secretPath, 0o600);
  }

  // ---------- CRUD ----------

  list(): ConnectionView[] {
    return this.connections.map((c) => this.toView(c));
  }

  get(id: string): Connection | undefined {
    return this.connections.find((c) => c.id === id);
  }

  create(input: ConnectionInput): ConnectionView {
    const meta = getAdapterMeta(input.adapterId);
    if (!meta) throw new UnsupportedAdapterError(input.adapterId);
    const connection: Connection = {
      id: randomUUID().slice(0, 8),
      adapterId: input.adapterId,
      label: input.label.trim() || `${meta.name} 连接`,
      testnet: input.testnet ?? meta.supportsTestnet,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.connections.push(connection);
    this.secrets.set(connection.id, {
      apiKey: input.apiKey ?? "",
      apiSecret: input.apiSecret ?? "",
    });
    this.persist();
    return this.toView(connection);
  }

  update(id: string, patch: Partial<ConnectionInput>): ConnectionView {
    const connection = this.get(id);
    if (!connection) throw new Error(`连接不存在: ${id}`);
    if (patch.label !== undefined) connection.label = patch.label.trim() || connection.label;
    if (patch.testnet !== undefined) connection.testnet = patch.testnet;
    if (patch.adapterId && patch.adapterId !== connection.adapterId) {
      if (!getAdapterMeta(patch.adapterId)) throw new UnsupportedAdapterError(patch.adapterId);
      connection.adapterId = patch.adapterId;
    }
    const current = this.secrets.get(id) ?? { apiKey: "", apiSecret: "" };
    this.secrets.set(id, {
      apiKey: patch.apiKey !== undefined && patch.apiKey !== "" ? patch.apiKey : current.apiKey,
      apiSecret: patch.apiSecret !== undefined && patch.apiSecret !== "" ? patch.apiSecret : current.apiSecret,
    });
    this.adapters.delete(id);
    this.persist();
    return this.toView(connection);
  }

  remove(id: string): void {
    const before = this.connections.length;
    this.connections = this.connections.filter((c) => c.id !== id);
    this.secrets.delete(id);
    this.adapters.delete(id);
    if (this.connections.length !== before) this.persist();
  }

  // ---------- 适配器实例 ----------

  /** 获取（并缓存）已注入密钥的适配器实例。 */
  adapter(id: string): ExchangeAdapter {
    const cached = this.adapters.get(id);
    if (cached) return cached;
    const connection = this.get(id);
    if (!connection) throw new Error(`连接不存在: ${id}`);
    const secret = this.secrets.get(id) ?? { apiKey: "", apiSecret: "" };
    const adapter = createAdapter(connection, secret);
    adapter.init({ ...secret, testnet: connection.testnet });
    this.adapters.set(id, adapter);
    return adapter;
  }

  async test(id: string): Promise<ConnectionTest> {
    const connection = this.get(id);
    if (!connection) throw new Error(`连接不存在: ${id}`);
    return this.adapter(id).testConnection();
  }

  // ---------- 视图 ----------

  private toView(connection: Connection): ConnectionView {
    const secret = this.secrets.get(connection.id);
    return {
      ...connection,
      hasKey: Boolean(secret?.apiKey),
      hasSecret: Boolean(secret?.apiSecret),
      adapter: getAdapterMeta(connection.adapterId)!,
    };
  }
}

export { redactConfig };
