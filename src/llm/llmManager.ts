/**
 * LLM 管理器：多实例（模型端点）池 + 负载均衡 + 熔断 + 调用统计。
 *
 * 实现 LLMClient 接口，因此策略层无需任何改动即可享受负载均衡。
 *
 * 负载均衡策略：
 * - round-robin：轮询（默认）
 * - weighted   ：按权重轮询（权重 1~100）
 * - random     ：随机
 * - latency    : 优先选择平均延迟最低的健康实例
 *
 * 熔断：连续失败达到阈值后进入冷却期，冷却期内不再选中；到期后半开试探。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LLMClient } from "./llmClient.js";
import { OpenAICompatClient } from "./openaiClient.js";
import { SystemOneClient, buildStateFromPrompt } from "./systemOne.js";
import { getLogger } from "../core/logger.js";
import { SecretStore } from "../store/secrets.js";

const log = getLogger("llm-manager");
const SCOPE = "llm";

export type BalanceStrategy = "round-robin" | "weighted" | "random" | "latency";

export const STRATEGY_LABEL: Record<BalanceStrategy, string> = {
  "round-robin": "轮询（Round Robin）",
  weighted: "加权轮询（Weighted）",
  random: "随机（Random）",
  latency: "最低延迟优先（Latency）",
};

/** 模型类型：对话模型（chat）或 System One 纯决策模型（systemone）。 */
export type ModelKind = "chat" | "systemone";

/** 一个模型端点配置（不含密钥）。 */
export interface LlmProfile {
  id: string;
  label: string;
  kind: ModelKind;
  /** openai-compatible / jev / Laya / 自定义，仅作标记与展示 */
  provider: string;
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  /** 权重 1~100，weighted 策略生效 */
  weight: number;
  enabled: boolean;
  createdAt: string;
  /** System One：档位标签（从低到高） */
  levels: string[];
  /** System One：每个档位对应的目标仓位权重（与 levels 等长，0~1） */
  levelWeights: number[];
  /** System One：提问内容 */
  instructions: string;
}

/** System One 预设：不同厂商的默认地址/模型。 */
export const SYSTEM_ONE_PRESETS: Record<string, { baseUrl: string; model: string; label: string }> = {
  jev: { baseUrl: "https://jev-api.com/v1", model: "jev-latest", label: "Jev (TypeSafe)" },
  Laya: { baseUrl: "http://127.0.0.1:8080/v1", model: "Laya-latest", label: "Laya（自托管）" },
  alibaba: { baseUrl: "https://dashscope.aliyuncs.com/api/v1", model: "qwen-systemone", label: "阿里云百炼" },
  custom: { baseUrl: "", model: "systemone", label: "自定义 System One" },
};

export const DEFAULT_LEVELS = ["flat", "weak", "moderate", "strong"];
export const DEFAULT_LEVEL_WEIGHTS = [0, 0.25, 0.5, 0.9];
export const DEFAULT_INSTRUCTIONS =
  "根据给定的K线序列与市场解读，评估未来若干根K线该标的的上涨强度。信息不足或趋势不明时选最低档。";

/** 运行期统计（不持久化）。 */
export interface LlmStats {
  calls: number;
  success: number;
  failures: number;
  consecutiveFailures: number;
  avgLatencyMs: number;
  lastLatencyMs: number;
  lastError: string;
  lastUsedAt: string;
  /** 是否处于熔断冷却 */
  cooldownUntil: number;
}

export interface LlmProfileView extends LlmProfile {
  hasKey: boolean;
  stats: LlmStats;
  healthy: boolean;
}

export interface LlmProfileInput {
  label: string;
  kind?: ModelKind;
  provider?: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  timeoutMs?: number;
  weight?: number;
  enabled?: boolean;
  levels?: string[];
  levelWeights?: number[];
  instructions?: string;
}

export interface LlmManagerOptions {
  /** 连续失败多少次触发熔断 */
  breakerThreshold?: number;
  /** 冷却时长（毫秒） */
  cooldownMs?: number;
}

const DEFAULT_BREAKER = 3;
const DEFAULT_COOLDOWN = 60_000;

export class LlmManager implements LLMClient {
  readonly name = "llm-manager";

  private profiles: LlmProfile[] = [];
  private stats = new Map<string, LlmStats>();
  private clients = new Map<string, OpenAICompatClient | SystemOneClient>();
  private rrIndex = 0;
  private activeKind: ModelKind = "chat";
  private readonly secrets: SecretStore;
  private readonly key: (id: string) => string;
  private readonly path: string;
  private readonly breaker: number;
  private readonly cooldown: number;

  constructor(
    private readonly dataDir: string,
    private strategy: BalanceStrategy = "round-robin",
    options: LlmManagerOptions = {},
  ) {
    this.secrets = new SecretStore(dataDir);
    this.key = this.secrets.namespace(SCOPE);
    this.path = join(dataDir, "llm.json");
    this.breaker = options.breakerThreshold ?? DEFAULT_BREAKER;
    this.cooldown = options.cooldownMs ?? DEFAULT_COOLDOWN;
    this.load();
  }

  // ---------------- 持久化 ----------------

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      this.profiles = JSON.parse(readFileSync(this.path, "utf8")) as LlmProfile[];
    } catch (err) {
      log.warn("llm.json 解析失败: %s", (err as Error).message);
      this.profiles = [];
    }
  }

  private persist(): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.profiles, null, 2), { mode: 0o600 });
  }

  // ---------------- CRUD ----------------

  list(): LlmProfileView[] {
    return this.profiles.map((p) => this.view(p));
  }

  get(id: string): LlmProfile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  create(input: LlmProfileInput): LlmProfileView {
    const profile: LlmProfile = {
      id: randomUUID().slice(0, 8),
      label: input.label.trim() || input.model,
      kind: input.kind ?? "chat",
      provider: input.provider ?? "openai-compatible",
      baseUrl: input.baseUrl.replace(/\/$/, ""),
      model: input.model,
      temperature: input.temperature ?? 0.2,
      timeoutMs: input.timeoutMs ?? 20000,
      weight: clampWeight(input.weight ?? 1),
      enabled: input.enabled ?? true,
      createdAt: new Date().toISOString(),
      levels: input.levels?.length ? input.levels : [...DEFAULT_LEVELS],
      levelWeights: normalizeWeights(input.levelWeights ?? input.levels?.length ? DEFAULT_LEVEL_WEIGHTS : undefined),
      instructions: input.instructions?.trim() || DEFAULT_INSTRUCTIONS,
    };
    this.profiles.push(profile);
    this.secrets.set(this.key(profile.id), { apiKey: input.apiKey ?? "", apiSecret: "" });
    this.persist();
    return this.view(profile);
  }

  update(id: string, patch: Partial<LlmProfileInput>): LlmProfileView {
    const profile = this.get(id);
    if (!profile) throw new Error(`LLM 配置不存在: ${id}`);
    if (patch.label !== undefined) profile.label = patch.label.trim() || profile.label;
    if (patch.kind !== undefined) profile.kind = patch.kind;
    if (patch.provider !== undefined) profile.provider = patch.provider;
    if (patch.baseUrl !== undefined) profile.baseUrl = patch.baseUrl.replace(/\/$/, "");
    if (patch.model !== undefined) profile.model = patch.model;
    if (patch.temperature !== undefined) profile.temperature = patch.temperature;
    if (patch.timeoutMs !== undefined) profile.timeoutMs = patch.timeoutMs;
    if (patch.weight !== undefined) profile.weight = clampWeight(patch.weight);
    if (patch.enabled !== undefined) profile.enabled = patch.enabled;
    if (patch.levels && patch.levels.length > 0) profile.levels = [...patch.levels];
    if (patch.levelWeights) profile.levelWeights = normalizeWeights(patch.levelWeights);
    if (patch.instructions) profile.instructions = patch.instructions;
    if (patch.apiKey) this.secrets.patch(this.key(id), { apiKey: patch.apiKey });
    this.clients.delete(id);
    this.persist();
    return this.view(profile);
  }

  remove(id: string): void {
    const before = this.profiles.length;
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.secrets.delete(this.key(id));
    this.clients.delete(id);
    this.stats.delete(id);
    if (this.profiles.length !== before) this.persist();
  }

  setStrategy(strategy: BalanceStrategy): void {
    this.strategy = strategy;
  }

  /** 设置当前生效的模型池（对话模型 or 决策模型）。 */
  setActiveKind(kind: ModelKind): void {
    this.activeKind = kind;
  }

  getActiveKind(): ModelKind {
    return this.activeKind;
  }

  getStrategy(): BalanceStrategy {
    return this.strategy;
  }

  resetStats(id?: string): void {
    if (id) {
      this.stats.set(id, emptyStats());
      return;
    }
    this.stats.clear();
  }

  // ---------------- 负载均衡 ----------------

  /** 可用实例：已启用、有 Key、未在冷却中。可按模型类型过滤。 */
  available(kind?: ModelKind): LlmProfile[] {
    const now = Date.now();
    return this.profiles.filter((p) => {
      if (kind && p.kind !== kind) return false;
      if (!p.enabled) return false;
      if (!this.secrets.hasKey(this.key(p.id))) return false;
      const s = this.stats.get(p.id);
      return !(s && s.cooldownUntil > now);
    });
  }

  /** 按当前策略挑选一个实例；可按模型类型过滤。 */
  pick(kind?: ModelKind): LlmProfile | null {
    const pool = this.available(kind);
    if (pool.length === 0) return null;
    if (pool.length === 1) return pool[0]!;

    switch (this.strategy) {
      case "random":
        return pool[Math.floor(Math.random() * pool.length)]!;
      case "latency": {
        return [...pool].sort((a, b) => this.latencyOf(a.id) - this.latencyOf(b.id))[0]!;
      }
      case "weighted":
        return this.pickWeighted(pool);
      case "round-robin":
      default: {
        const picked = pool[this.rrIndex % pool.length]!;
        this.rrIndex = (this.rrIndex + 1) % pool.length;
        return picked;
      }
    }
  }

  /** 加权轮询：按权重展开成序列再取模，简单且可预测。 */
  private pickWeighted(pool: LlmProfile[]): LlmProfile {
    const total = pool.reduce((sum, p) => sum + p.weight, 0);
    if (total <= 0) return pool[0]!;
    let cursor = this.rrIndex % total;
    for (const p of pool) {
      cursor -= p.weight;
      if (cursor < 0) {
        this.rrIndex = (this.rrIndex + 1) % total;
        return p;
      }
    }
    this.rrIndex = (this.rrIndex + 1) % total;
    return pool[pool.length - 1]!;
  }

  // ---------------- 调用 ----------------

  private latencyOf(id: string): number {
    const s = this.stats.get(id);
    return s && s.avgLatencyMs > 0 ? s.avgLatencyMs : 0;
  }

  private client(profile: LlmProfile): OpenAICompatClient | SystemOneClient {
    const cached = this.clients.get(profile.id);
    if (cached) return cached;
    const secret = this.secrets.get(this.key(profile.id));
    if (profile.kind === "systemone") {
      const so = new SystemOneClient({
        baseUrl: profile.baseUrl,
        apiKey: secret.apiKey,
        model: profile.model,
        timeoutMs: profile.timeoutMs,
        levels: profile.levels,
        levelWeights: profile.levelWeights,
        instructions: profile.instructions,
        buildState: buildStateFromPrompt,
      });
      this.clients.set(profile.id, so);
      return so;
    }
    const client = new OpenAICompatClient({
      baseUrl: profile.baseUrl,
      apiKey: secret.apiKey,
      model: profile.model,
      temperature: profile.temperature,
      timeoutMs: profile.timeoutMs,
    });
    this.clients.set(profile.id, client);
    return client;
  }

  /**
   * 发送一次请求。失败时自动故障转移到下一个可用实例（最多一次）。
   * 全部实例不可用或均失败则抛出最后一个错误，由上层回退规则策略。
   */
  async complete(prompt: string, kind?: ModelKind): Promise<string> {
    const pool = kind ?? this.activeKind;
    const first = this.pick(pool);
    if (!first) {
      throw new Error(
        pool === "systemone"
          ? "没有可用的 System One 决策模型（请在「模型管理 → 决策模型」页添加并配置密钥）"
          : "没有可用的对话模型（请在「模型管理 → 对话模型」页添加并配置密钥）",
      );
    }
    let lastError: Error = new Error("未知错误");
    const tried = new Set<string>();
    for (const profile of [first, ...this.available(pool).filter((p) => p.id !== first.id)]) {
      if (tried.has(profile.id)) continue;
      tried.add(profile.id);
      try {
        return await this.callOne(profile, prompt);
      } catch (err) {
        lastError = err as Error;
        log.warn("%s 调用失败: %s", profile.label, lastError.message);
      }
    }
    throw lastError;
  }

  private async callOne(profile: LlmProfile, prompt: string): Promise<string> {
    const started = Date.now();
    const stat = this.statsOf(profile.id);
    stat.calls += 1;
    stat.lastUsedAt = new Date().toISOString();
    try {
      const text = await this.client(profile).complete(prompt);
      const latency = Date.now() - started;
      stat.success += 1;
      stat.consecutiveFailures = 0;
      stat.cooldownUntil = 0;
      stat.lastLatencyMs = latency;
      stat.avgLatencyMs = Math.round(stat.avgLatencyMs * 0.7 + latency * 0.3);
      stat.lastError = "";
      return text;
    } catch (err) {
      const latency = Date.now() - started;
      stat.failures += 1;
      stat.consecutiveFailures += 1;
      stat.lastLatencyMs = latency;
      stat.avgLatencyMs = Math.round(stat.avgLatencyMs * 0.7 + latency * 0.3);
      stat.lastError = (err as Error).message;
      if (stat.consecutiveFailures >= this.breaker) {
        stat.cooldownUntil = Date.now() + this.cooldown;
        log.warn("%s 连续失败 %d 次，熔断 %dms", profile.label, stat.consecutiveFailures, this.cooldown);
      }
      throw err;
    }
  }

  /**
   * 取指定实例的直连客户端（不经过负载均衡）。
   * 多模型对照实验里，每个选手独立操盘、各自记账，互不干扰。
   */
  clientFor(profileId: string): { client: LLMClient; profile: LlmProfile } | null {
    const profile = this.get(profileId);
    if (!profile) return null;
    if (!this.secrets.hasKey(this.key(profileId))) return null;
    return { client: this.client(profile), profile };
  }

  /** 指定实例直接调用（用于「测试连接」按钮），不参与负载均衡。 */
  async testProfile(id: string, prompt: string): Promise<{ ok: boolean; message: string; latencyMs: number }> {
    const profile = this.get(id);
    if (!profile) throw new Error(`LLM 配置不存在: ${id}`);
    if (!this.secrets.hasKey(this.key(id))) {
      return { ok: false, message: "未配置 API Key", latencyMs: 0 };
    }
    const started = Date.now();
    try {
      const text = await this.callOne(profile, prompt);
      return {
        ok: true,
        message: text.slice(0, 200) || "(空响应)",
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message, latencyMs: Date.now() - started };
    }
  }

  // ---------------- 统计 ----------------

  private statsOf(id: string): LlmStats {
    let s = this.stats.get(id);
    if (!s) {
      s = emptyStats();
      this.stats.set(id, s);
    }
    return s;
  }

  /** 全局汇总（面板顶部用）。 */
  /** 各模型池的可用实例数（供决策来源选择器展示）。 */
  poolCounts(): { chat: { total: number; available: number }; systemone: { total: number; available: number } } {
    const count = (kind: ModelKind) => {
      const all = this.profiles.filter((p) => p.kind === kind);
      return { total: all.length, available: this.available(kind).length };
    };
    return { chat: count("chat"), systemone: count("systemone") };
  }

  overview(): { total: number; available: number; calls: number; success: number; avgLatencyMs: number } {
    let calls = 0;
    let success = 0;
    let weightedLatency = 0;
    for (const p of this.profiles) {
      const s = this.stats.get(p.id);
      if (!s) continue;
      calls += s.calls;
      success += s.success;
      weightedLatency += s.avgLatencyMs * (s.calls || 1);
    }
    return {
      total: this.profiles.length,
      available: this.available().length,
      calls,
      success,
      avgLatencyMs: calls > 0 ? Math.round(weightedLatency / calls) : 0,
    };
  }

  private view(profile: LlmProfile): LlmProfileView {
    const stat = this.statsOf(profile.id);
    return {
      ...profile,
      hasKey: this.secrets.hasKey(this.key(profile.id)),
      stats: { ...stat },
      healthy: stat.cooldownUntil <= Date.now(),
    };
  }
}

function emptyStats(): LlmStats {
  return {
    calls: 0,
    success: 0,
    failures: 0,
    consecutiveFailures: 0,
    avgLatencyMs: 0,
    lastLatencyMs: 0,
    lastError: "",
    lastUsedAt: "",
    cooldownUntil: 0,
  };
}

function clampWeight(w: number): number {
  if (!Number.isFinite(w)) return 1;
  return Math.min(Math.max(Math.round(w), 1), 100);
}

/** 档位权重：长度对齐 levels，缺失补 0，并夹到 0~1。 */
function normalizeWeights(weights?: number[]): number[] {
  const base = weights ?? DEFAULT_LEVEL_WEIGHTS;
  return base.map((w) => (Number.isFinite(w) ? Math.min(Math.max(w, 0), 1) : 0));
}