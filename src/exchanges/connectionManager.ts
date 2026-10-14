/**
 * 交易所连接：CRUD、密钥保管、连接测试、适配器实例缓存。
 * 元信息存 data/connections.json，密钥存 data/secrets.json（共享 SecretStore）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAdapter, getAdapterMeta, UnsupportedAdapterError } from "./registry.js";
import type { AdapterMeta, Connection, ConnectionTest, ExchangeAdapter } from "./types.js";
import { getLogger } from "../core/logger.js";
import { SecretStore } from "../store/secrets.js";
import { redactConfig } from "../configSchema.js";

const log = getLogger("connections");

const SCOPE = "conn";

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
  private adapters = new Map<string, ExchangeAdapter>();
  private readonly secrets: SecretStore;
  private readonly key: (id: string) => string;
  private readonly metaPath: string;

  constructor(private readonly dataDir: string) {
    this.secrets = new SecretStore(dataDir);
    this.key = this.secrets.namespace(SCOPE);
    this.metaPath = join(dataDir, "connections.json");
    this.load();
  }

  private load(): void {
    const path = this.metaPath;
    if (!existsSync(path)) return;
    try {
      this.connections = JSON.parse(readFileSync(path, "utf8")) as Connection[];
    } catch (err) {
      log.warn("connections.json 解析失败，使用空列表: %s", (err as Error).message);
      this.connections = [];
    }
  }

  private persist(): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.metaPath, JSON.stringify(this.connections, null, 2), { mode: 0o600 });
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
    this.secrets.set(this.key(connection.id), {
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
    this.secrets.patch(this.key(id), { apiKey: patch.apiKey, apiSecret: patch.apiSecret });
    this.adapters.delete(id);
    this.persist();
    return this.toView(connection);
  }

  remove(id: string): void {
    const before = this.connections.length;
    this.connections = this.connections.filter((c) => c.id !== id);
    this.secrets.delete(this.key(id));
    this.adapters.delete(id);
    if (this.connections.length !== before) this.persist();
  }

  // ---------- 适配器实例 ----------

  adapter(id: string): ExchangeAdapter {
    const cached = this.adapters.get(id);
    if (cached) return cached;
    const connection = this.get(id);
    if (!connection) throw new Error(`连接不存在: ${id}`);
    const secret = this.secrets.get(this.key(id));
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
    const secret = this.secrets.get(this.key(connection.id));
    return {
      ...connection,
      hasKey: Boolean(secret.apiKey),
      hasSecret: Boolean(secret.apiSecret),
      adapter: getAdapterMeta(connection.adapterId)!,
    };
  }
}

export { redactConfig };