/**
 * 策略列表：把「策略」从全局配置里的一个字段变成可管理的实体。
 *
 * 为什么：以前策略参数只活在 AppConfig.strategy 里，机器人各自带一份覆盖参数。
 * 结果是同一套「双均线 + AI 选资产」想在两个机器人上用，就得把窗口/仓位/影响力
 * 在两处各填一遍，改一次要改两处，久了必然对不上。
 * 现在策略是一等公民：建一次、取名字、多个机器人引用同一个 id；
 * 单次运行用「默认策略」。
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../core/logger.js";
import { safeDecisionSource, type DecisionSource } from "../configSchema.js";

const log = getLogger("strategies");

/** 一条策略。字段与 AppConfig.strategy 保持一致，便于直接展开成局部配置。 */
export interface StrategyProfile {
  id: string;
  name: string;
  /** 说明（可选）：这条策略想干什么 */
  note?: string;
  /** 决策来源：量化（纯规则）| 对话模型 | 决策模型 | 混合 */
  decisionSource: DecisionSource;
  fastWindow: number;
  slowWindow: number;
  maxTargetWeight: number;
  selfAllocating: boolean;
  maxPositions: number;
  maxGrossExposure: number;
  allocationInterval: number;
  hybridInfluence: number;
  hybridAnalysisTtlMs: number;
  createdAt: string;
}

/** 新建策略时可省略的字段（有默认值）。 */
export interface StrategyProfileInput {
  name: string;
  note?: string;
  decisionSource?: DecisionSource;
  fastWindow?: number;
  slowWindow?: number;
  maxTargetWeight?: number;
  selfAllocating?: boolean;
  maxPositions?: number;
  maxGrossExposure?: number;
  allocationInterval?: number;
  hybridInfluence?: number;
  hybridAnalysisTtlMs?: number;
}

/** 默认策略 id：从旧配置迁移来的那条就用它，保证引用不断。 */
export const DEFAULT_STRATEGY_ID = "default";

const DEFAULTS = {
  decisionSource: "rules" as DecisionSource,
  fastWindow: 5,
  slowWindow: 20,
  maxTargetWeight: 0.5,
  selfAllocating: false,
  maxPositions: 3,
  maxGrossExposure: 1,
  allocationInterval: 5,
  hybridInfluence: 0.6,
  hybridAnalysisTtlMs: 300_000,
};

export interface StrategyStoreOptions {
  /** 旧配置里的 strategy 段，用于首次启动时迁移成默认策略 */
  seed?: Partial<StrategyProfile>;
  /** 只在内存里跑，不落盘（测试与一次性对照实验用） */
  memoryOnly?: boolean;
}

export class StrategyStore {
  private profiles: StrategyProfile[] = [];
  private defaultId: string = DEFAULT_STRATEGY_ID;

  private readonly memoryOnly: boolean;

  constructor(
    private readonly dataDir: string,
    options: StrategyStoreOptions = {},
  ) {
    this.memoryOnly = options.memoryOnly ?? false;
    this.load(options.seed);
  }

  private get path(): string {
    return join(this.dataDir, "strategies.json");
  }

  /**
   * 读盘。文件不存在时用旧配置 seed 出「默认策略」——
   * 这样老配置升级后行为不变，且立刻有一条可用策略。
   */
  private load(seed?: Partial<StrategyProfile>): void {
    if (!this.memoryOnly && existsSync(this.path)) {
      try {
        const data = JSON.parse(readFileSync(this.path, "utf8")) as {
          strategies?: StrategyProfile[];
          defaultId?: string;
        };
        if (Array.isArray(data.strategies) && data.strategies.length > 0) {
          this.profiles = data.strategies.map((p) => this.hydrate(p));
          this.defaultId = this.profiles.some((p) => p.id === data.defaultId)
            ? data.defaultId!
            : this.profiles[0]!.id;
          return;
        }
      } catch (err) {
        log.warn("strategies.json 解析失败，用默认策略重建: %s", (err as Error).message);
      }
    }
    this.profiles = [this.hydrate({ ...DEFAULTS, ...seed, id: DEFAULT_STRATEGY_ID, name: seed?.name ?? "默认策略" })];
    this.defaultId = this.profiles[0]!.id;
    this.persist();
  }

  /** 补齐缺省字段：老数据/手改文件里少字段时不至于 undefined 满天飞。 */
  private hydrate(raw: Partial<StrategyProfile>): StrategyProfile {
    const now = new Date().toISOString();
    return {
      id: String(raw.id ?? randomUUID().slice(0, 8)),
      name: String(raw.name ?? "未命名策略"),
      note: raw.note,
      decisionSource: safeDecisionSource(String(raw.decisionSource ?? DEFAULTS.decisionSource)),
      fastWindow: Math.max(2, Number(raw.fastWindow ?? DEFAULTS.fastWindow)),
      slowWindow: Math.max(3, Number(raw.slowWindow ?? DEFAULTS.slowWindow)),
      maxTargetWeight: Math.min(Math.max(Number(raw.maxTargetWeight ?? DEFAULTS.maxTargetWeight), 0.01), 1),
      selfAllocating: Boolean(raw.selfAllocating ?? DEFAULTS.selfAllocating),
      maxPositions: Math.max(1, Number(raw.maxPositions ?? DEFAULTS.maxPositions)),
      maxGrossExposure: Math.min(Math.max(Number(raw.maxGrossExposure ?? DEFAULTS.maxGrossExposure), 0.05), 1),
      allocationInterval: Math.max(1, Number(raw.allocationInterval ?? DEFAULTS.allocationInterval)),
      hybridInfluence: Math.min(Math.max(Number(raw.hybridInfluence ?? DEFAULTS.hybridInfluence), 0), 1),
      hybridAnalysisTtlMs: Math.max(30_000, Number(raw.hybridAnalysisTtlMs ?? DEFAULTS.hybridAnalysisTtlMs)),
      createdAt: String(raw.createdAt ?? now),
    };
  }

  private persist(): void {
    if (this.memoryOnly) return;
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(
      this.path,
      JSON.stringify({ defaultId: this.defaultId, strategies: this.profiles }, null, 2),
      { mode: 0o600 },
    );
  }

  list(): StrategyProfile[] {
    return this.profiles.map((p) => ({ ...p }));
  }

  get(id: string): StrategyProfile | undefined {
    const p = this.profiles.find((x) => x.id === id);
    return p ? { ...p } : undefined;
  }

  default(): StrategyProfile {
    return this.get(this.defaultId) ?? this.list()[0]!;
  }

  defaultIdValue(): string {
    return this.defaultId;
  }

  private genId(): string {
    let id = randomUUID().slice(0, 8);
    while (this.profiles.some((p) => p.id === id)) id = randomUUID().slice(0, 8);
    return id;
  }

  private uniqueName(name: string): string {
    const base = name.trim() || "未命名策略";
    if (!this.profiles.some((p) => p.name === base)) return base;
    let n = 2;
    while (this.profiles.some((p) => p.name === `${base} ${n}`)) n += 1;
    return `${base} ${n}`;
  }

  create(input: StrategyProfileInput, base?: string): StrategyProfile {
    const from = base ? this.get(base) : undefined;
    if (base && !from) throw new Error(`基础策略不存在: ${base}`);
    const { name: rawName, ...restInput } = input;
    const created = this.hydrate({
      ...DEFAULTS,
      ...(from ? this.pick(from) : {}),
      ...restInput,
      id: this.genId(),
      name: this.uniqueName(rawName),
      createdAt: new Date().toISOString(),
    });
    this.profiles.push(created);
    this.persist();
    log.info("新建策略「%s」(%s)", created.name, created.id);
    return { ...created };
  }

  /** 从现有策略复制（含决策来源与全部参数）。 */
  duplicate(id: string): StrategyProfile {
    const src = this.get(id);
    if (!src) throw new Error(`策略不存在: ${id}`);
    const { name: _n, ...params } = this.pick(src);
    return this.create({ name: `${src.name} 副本`, ...params }, id);
  }

  update(id: string, patch: Partial<StrategyProfileInput> & { id?: string }): StrategyProfile {
    const idx = this.profiles.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error(`策略不存在: ${id}`);
    const current = this.profiles[idx]!;
    // id / createdAt 不允许改
    this.profiles[idx] = this.hydrate({
      ...this.pick(current),
      ...patch,
      id: current.id,
      name: patch.name !== undefined ? this.uniqueName(patch.name) : current.name,
      createdAt: current.createdAt,
    });
    this.persist();
    return { ...this.profiles[idx]! };
  }

  remove(id: string): void {
    // 顺序有讲究：默认策略先报错，否则只剩一条时用户会看到「至少保留一条」这种没指向的提示
    if (id === this.defaultId) throw new Error("默认策略不能删除，请先把别的策略设为默认");
    if (this.profiles.length <= 1) throw new Error("至少保留一条策略");
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.persist();
  }

  setDefault(id: string): StrategyProfile {
    const p = this.get(id);
    if (!p) throw new Error(`策略不存在: ${id}`);
    this.defaultId = id;
    this.persist();
    return p;
  }

  /**
   * 取一条可用的策略：id 命中就用它；不存在（被删/迁移前的老配置）时退回默认策略，
   * 绝不因为引用失效就让机器人起不来。
   */
  resolve(id: string | undefined | null): StrategyProfile {
    if (id) {
      const p = this.get(id);
      if (p) return p;
      log.warn("策略 %s 不存在，退回默认策略", id);
    }
    return this.default();
  }

  private pick(p: StrategyProfile): StrategyProfileInput {
    const { id: _id, createdAt: _createdAt, ...rest } = p;
    return rest;
  }
}
