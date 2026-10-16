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

  /**
   * 该连接是否已配置 API Key —— 只回布尔值，不把密钥暴露给调用方。
   * 机器人判定"能不能实盘"时需要它。
   */
  hasKey(id: string): boolean {
    return Boolean(this.get(id)) && this.toView(this.connections.find((c) => c.id === id)!).hasKey;
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
    const adapter = this.build(id);
    this.adapters.set(id, adapter);
    return adapter;
  }

  /**
   * 建一个**独立**的适配器实例：不进缓存，用完即弃。
   *
   * 为什么必须分开：模拟交易所的情景种子长在适配器实例上，`newScenario()`
   * 换的是整个价格世界。历史模拟/对照如果直接拿连接上缓存的那个实例去跑，
   * 就会把正在实时运行的机器人脚下的行情一并换掉 —— 机器人下一根 K 线看到
   * 的价格和上一根出现断层，凭空冒出一笔成交。一次性历史运行不该改动实时
   * 连接的适配器状态，所以那边走这个方法。
   */
  independentAdapter(id: string): ExchangeAdapter {
    return this.build(id);
  }

  private build(id: string): ExchangeAdapter {
    const connection = this.get(id);
    if (!connection) throw new Error(`连接不存在: ${id}`);
    const secret = this.secrets.get(this.key(id));
    const adapter = createAdapter(connection, secret);
    adapter.init({ ...secret, testnet: connection.testnet });
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