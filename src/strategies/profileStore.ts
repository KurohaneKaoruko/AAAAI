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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../core/safeWrite.js";
import { join } from "node:path";
import { getLogger } from "../core/logger.js";
import { compileCustomCode } from "./customStrategy.js";
import { safeDecisionSource, MAX_STRATEGY_CODE_LENGTH, type DecisionSource, type StrategyEngine, safeStrategyEngine } from "../configSchema.js";

const log = getLogger("strategies");

/** 一条策略。字段与 AppConfig.strategy 保持一致，便于直接展开成局部配置。 */
export interface StrategyProfile {
  id: string;
  name: string;
  /** 说明（可选）：这条策略想干什么 */
  note?: string;
  /** 决策来源：量化（纯规则）| 对话模型 | 决策模型 | 混合 */
  decisionSource: DecisionSource;
  /** 纯规则引擎；模型决策时作为回退基线 */
  engine: StrategyEngine;
  fastWindow: number;
  slowWindow: number;
  maxTargetWeight: number;
  /** 合约模式下是否允许做空（现货忽略） */
  allowShort: boolean;
  selfAllocating: boolean;
  maxPositions: number;
  maxGrossExposure: number;
  allocationInterval: number;
  hybridInfluence: number;
  hybridAnalysisTtlMs: number;
  /** custom 引擎：用户编写的策略代码（沙箱执行的函数体）；其它引擎为空串 */
  strategyCode: string;
  createdAt: string;
}

/** 新建策略时可省略的字段（有默认值）。 */
export interface StrategyProfileInput {
  name: string;
  note?: string;
  decisionSource?: DecisionSource;
  engine?: StrategyEngine;
  fastWindow?: number;
  slowWindow?: number;
  maxTargetWeight?: number;
  allowShort?: boolean;
  selfAllocating?: boolean;
  maxPositions?: number;
  maxGrossExposure?: number;
  allocationInterval?: number;
  hybridInfluence?: number;
  hybridAnalysisTtlMs?: number;
  /** custom 引擎：策略代码（保存时会先编译校验 + 真实行情试跑） */
  strategyCode?: string;
}

/** 默认策略 id：从旧配置迁移来的那条就用它，保证引用不断。 */
export const DEFAULT_STRATEGY_ID = "default";

const DEFAULTS = {
  decisionSource: "rules" as DecisionSource,
  // 默认先用经典双均线；自适应引擎可通过策略页切换并单独验证
  engine: "momentum" as StrategyEngine,
  // 默认窗口（2/8）不是拍的「经典 5/20」：它是在多情景胜率上扫窗口网格实测选出的
  // 平台中值（依据、判定规则与测量表见 docs/architecture.md「设计取舍 · 默认策略」）。
  // 改这里要同步三处默认值（本文件 / configSchema.ts / config/default.yaml）
  // 与 test/strategies.test.ts、test/winRate.test.ts 里的锁。
  fastWindow: 2,
  slowWindow: 8,
  maxTargetWeight: 0.5,
  // 合约默认双向；现货风控会拒绝负权重，所以不会误开空
  allowShort: true,
  selfAllocating: false,
  maxPositions: 3,
  maxGrossExposure: 1,
  allocationInterval: 5,
  hybridInfluence: 0.6,
  hybridAnalysisTtlMs: 300_000,
  strategyCode: "",
};

/**
 * custom 引擎保存前的编译校验：语法错误 / 危险写法当场报。
 * 非 custom 引擎直接跳过（它们的参数在引擎构造函数里各自校验）。
 */
function validateIfCustom(p: StrategyProfile): void {
  if (p.engine !== "custom") return;
  compileCustomCode(p.strategyCode);
}

export interface StrategyStoreOptions {
  /** 旧配置里的 strategy 段，用于首次启动时迁移成默认策略 */
  seed?: Partial<StrategyProfile>;
  /** 只在内存里跑，不落盘（测试与一次性对照实验用） */
  memoryOnly?: boolean;
  /** 首次升级时补入官方策略预设（生产入口开启；测试默认关闭） */
  seedPresets?: boolean;
}

export class StrategyStore {
  private profiles: StrategyProfile[] = [];
  private defaultId: string = DEFAULT_STRATEGY_ID;
  /** 预设播种版本：只播一次，用户删掉后不会每次重启又冒出来 */
  private presetVersion = 0;

  private readonly memoryOnly: boolean;
  private readonly seedPresets: boolean;

  constructor(
    private readonly dataDir: string,
    options: StrategyStoreOptions = {},
  ) {
    this.memoryOnly = options.memoryOnly ?? false;
    this.seedPresets = options.seedPresets ?? false;
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
    let loaded = false;
    if (!this.memoryOnly && existsSync(this.path)) {
      try {
        const data = JSON.parse(readFileSync(this.path, "utf8")) as {
          strategies?: StrategyProfile[];
          defaultId?: string;
          presetVersion?: number;
        };
        if (Array.isArray(data.strategies) && data.strategies.length > 0) {
          this.profiles = data.strategies.map((p) => this.hydrate(p));
          this.defaultId = this.profiles.some((p) => p.id === data.defaultId)
            ? data.defaultId!
            : this.profiles[0]!.id;
          this.presetVersion = Number(data.presetVersion ?? 0) || 0;
          loaded = true;
        }
      } catch (err) {
        log.warn("strategies.json 解析失败，用默认策略重建: %s", (err as Error).message);
      }
    }
    if (!loaded) {
      this.profiles = [this.hydrate({ ...DEFAULTS, ...seed, id: DEFAULT_STRATEGY_ID, name: seed?.name ?? "默认策略" })];
      this.defaultId = this.profiles[0]!.id;
    }
    this.ensurePresets();
    this.ensurePresetV2();
    this.persist();
  }

  /**
   * 官方策略预设：只在第一次升级时补入，之后用户可以自由删改。
   * 不覆盖同名/同 id 的现有策略；默认策略仍是用户当前选中的那条。
   */
  private ensurePresets(): void {
    if (!this.seedPresets || this.presetVersion >= 1) return;
    const presets: Partial<StrategyProfile>[] = [
      {
        id: "preset-momentum",
        name: "时序动量 · 2/8",
        note: "经典双均线，t 统计量归一；模拟行情实测最优",
        engine: "momentum",
        fastWindow: 2,
        slowWindow: 8,
        maxTargetWeight: 0.5,
        allowShort: true,
      },
      {
        id: "preset-adaptive",
        name: "自适应趋势 · 5/20",
        note: "效率比 + 突破 + ATR 移动止损 + 波动率缩放",
        engine: "adaptive",
        fastWindow: 5,
        slowWindow: 20,
        maxTargetWeight: 0.5,
        allowShort: true,
      },
      {
        id: "preset-breakout",
        name: "唐奇安突破 · 20/10",
        note: "20 根通道突破入场、10 根反向通道离场，ATR 止损",
        engine: "breakout",
        fastWindow: 10,
        slowWindow: 20,
        maxTargetWeight: 0.5,
        allowShort: true,
      },
      {
        id: "preset-meanrev",
        name: "布林均值回归 · 5/20",
        note: "价格偏离均值 1.5σ 反向入场，短均线过滤强趋势",
        engine: "meanrev",
        fastWindow: 5,
        slowWindow: 20,
        maxTargetWeight: 0.5,
        allowShort: true,
      },
      {
        id: "preset-xsmom",
        name: "横截面多因子 · Top3",
        note: "趋势/动量/突破/量价因子排名取前 3，适合多标的候选池",
        engine: "momentum",
        fastWindow: 2,
        slowWindow: 8,
        maxTargetWeight: 0.5,
        allowShort: false,
        selfAllocating: true,
        maxPositions: 3,
      },
    ];
    let added = 0;
    for (const preset of presets) {
      const id = preset.id!;
      const exists = this.profiles.some((p) => p.id === id || p.name === preset.name);
      if (exists) continue;
      this.profiles.push(this.hydrate({ ...DEFAULTS, ...preset, createdAt: new Date().toISOString() }));
      added += 1;
    }
    this.presetVersion = 1;
    if (added > 0) log.info("已补入 %d 条官方策略预设", added);
    return;
  }

  /**
   * 预设 v2：参数按**真实行情**重新调优。
   *
   * v1 的参数（尤其动量 2/8）是在本地模拟走向上调出来的：人造趋势干净、
   * 噪声极小，z 轻松冲过门槛。放到真实 5m 行情上，2/8 的 t 统计量每两根
   * K 线翻转一次，迟滞引擎一天也要进出二十多次，手续费把方向收益吃穿
   * （实测 -8.6%/1000根，其中摩擦占九成）。
   * 在真实 Binance 5m 行情上重扫参数：12~24/36~64 是一片正收益高原
   * （16/48：+0.66%/500根、+0.47%/1000根），选高原中位 16/48，不追孤立尖峰。
   * 只改官方预设的参数与说明；用户自建/改过的策略一律不碰。
   */
  private ensurePresetV2(): void {
    if (!this.seedPresets || this.presetVersion >= 2) return;
    const tune: Record<string, { fastWindow: number; slowWindow: number; note: string }> = {
      // 时序动量：2/8 → 16/48（真实 5m 行情参数高原的中位）
      "preset-momentum": {
        fastWindow: 16,
        slowWindow: 48,
        note: "经典双均线 t 统计量 + 迟滞带；参数在真实 Binance 5m 行情上调优",
      },
      // 自适应趋势：5/20 → 12/48（同一片高原，效率比过滤吃掉短窗口噪声）
      "preset-adaptive": {
        fastWindow: 12,
        slowWindow: 48,
        note: "效率比 + 突破 + ATR 移动止损 + 波动率缩放；真实行情调优",
      },
      // 唐奇安突破：20/10 → 60/30（5m 上 20 根通道太窄，半个多小时就破一次）
      "preset-breakout": {
        fastWindow: 30,
        slowWindow: 60,
        note: "60 根通道突破入场、30 根反向通道离场，ATR 止损；真实行情调优",
      },
      // 均值回归窗口同步放宽：5/20 的布林带在 5m 上贴脸，1.5σ 满地都是
      "preset-meanrev": {
        fastWindow: 12,
        slowWindow: 48,
        note: "布林均值回归 + 回归出场/止损/超时；真实行情调优",
      },
      // 横截面与动量同引擎：跟随调到 16/48
      "preset-xsmom": {
        fastWindow: 16,
        slowWindow: 48,
        note: "趋势/动量/突破/量价因子排名取前 3，适合多标的候选池；真实行情调优",
      },
    };
    let tuned = 0;
    for (const [id, patch] of Object.entries(tune)) {
      const idx = this.profiles.findIndex((p) => p.id === id);
      if (idx < 0) continue;
      const current = this.profiles[idx]!;
      this.profiles[idx] = this.hydrate({ ...this.pick(current), ...patch, id, createdAt: current.createdAt });
      tuned += 1;
    }
    this.presetVersion = 2;
    if (tuned > 0) log.info("官方预设已按真实行情调优（v2）：更新 %d 条参数", tuned);
  }

  /** 补齐缺省字段：老数据/手改文件里少字段时不至于 undefined 满天飞。 */
  private hydrate(raw: Partial<StrategyProfile>): StrategyProfile {
    const now = new Date().toISOString();
    return {
      id: String(raw.id ?? randomUUID().slice(0, 8)),
      name: String(raw.name ?? "未命名策略"),
      note: raw.note,
      decisionSource: safeDecisionSource(String(raw.decisionSource ?? DEFAULTS.decisionSource)),
      engine: safeStrategyEngine(String(raw.engine ?? DEFAULTS.engine)),
      fastWindow: Math.max(2, Number(raw.fastWindow ?? DEFAULTS.fastWindow)),
      slowWindow: Math.max(3, Number(raw.slowWindow ?? DEFAULTS.slowWindow)),
      maxTargetWeight: Math.min(Math.max(Number(raw.maxTargetWeight ?? DEFAULTS.maxTargetWeight), 0.01), 1),
      allowShort: Boolean(raw.allowShort ?? DEFAULTS.allowShort),
      selfAllocating: Boolean(raw.selfAllocating ?? DEFAULTS.selfAllocating),
      maxPositions: Math.max(1, Number(raw.maxPositions ?? DEFAULTS.maxPositions)),
      maxGrossExposure: Math.min(Math.max(Number(raw.maxGrossExposure ?? DEFAULTS.maxGrossExposure), 0.05), 1),
      allocationInterval: Math.max(1, Number(raw.allocationInterval ?? DEFAULTS.allocationInterval)),
      hybridInfluence: Math.min(Math.max(Number(raw.hybridInfluence ?? DEFAULTS.hybridInfluence), 0), 1),
      hybridAnalysisTtlMs: Math.max(30_000, Number(raw.hybridAnalysisTtlMs ?? DEFAULTS.hybridAnalysisTtlMs)),
      // custom 引擎的用户代码；engine != custom 时保持空串
      strategyCode: String(raw.strategyCode ?? "").slice(0, MAX_STRATEGY_CODE_LENGTH),
      createdAt: String(raw.createdAt ?? now),
    };
  }

  private persist(): void {
    if (this.memoryOnly) return;
    mkdirSync(this.dataDir, { recursive: true });
    writeFileAtomic(
      this.path,
      JSON.stringify({ defaultId: this.defaultId, presetVersion: this.presetVersion, strategies: this.profiles }, null, 2),
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
    // custom 引擎保存前先编译：语法错误当场报，别等机器人启动才炸
    validateIfCustom(created);
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
    // 先在副本上合成新值并校验，全部通过才落地：
    // 校验抛错时内存里必须还是旧策略（否则一次改错代码就把线上引用改坏）。
    const next = this.hydrate({
      ...this.pick(current),
      ...patch,
      id: current.id,
      name: patch.name !== undefined ? this.uniqueName(patch.name) : current.name,
      createdAt: current.createdAt,
    });
    // custom 引擎保存前先编译：改坏代码当场报，线上机器人还跑着旧实例不受影响
    validateIfCustom(next);
    this.profiles[idx] = next;
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

/**
 * 策略实体 -> AppConfig.strategy 需要的字段（只挑策略侧，不动其它段）。
 * 放在这里而不是各调用方自己展开：策略页保存、机器人启动、对照实验选手装配
 * 都要用同一份映射，否则三处各写一遍，迟早有一处漏字段。
 */
export function strategyFields(p: StrategyProfile): Record<string, unknown> {
  return {
    decisionSource: p.decisionSource,
    engine: p.engine,
    fastWindow: p.fastWindow,
    slowWindow: p.slowWindow,
    maxTargetWeight: p.maxTargetWeight,
    allowShort: p.allowShort,
    selfAllocating: p.selfAllocating,
    maxPositions: p.maxPositions,
    maxGrossExposure: p.maxGrossExposure,
    allocationInterval: p.allocationInterval,
    hybridInfluence: p.hybridInfluence,
    hybridAnalysisTtlMs: p.hybridAnalysisTtlMs,
    strategyCode: p.strategyCode,
  };
}
