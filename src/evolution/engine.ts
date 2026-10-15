/**
 * 决策日志 + 自适应调参器。
 *
 * 日志负责「记住做过什么、结果如何」；调参器负责「据统计决定改不改、怎么改」。
 * 两者都写盘（data/evolution.json），重启后学习记录不丢。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../core/logger.js";
import { PARAM_RULES } from "./types.js";
import type { AppConfig, EvolutionSection } from "../configSchema.js";
import {
  paramLabel,
  proposeTuning,
  type ChangeLogEntry,
  type DecisionOutcome,
  type DecisionRecord,
  type EvolutionStats,
  type EvolutionView,
} from "./types.js";

const log = getLogger("evolution");

const MAX_RECORDS = 500;
const MAX_CHANGELOG = 50;

interface Persisted {
  seq: number;
  records: DecisionRecord[];
  changelog: ChangeLogEntry[];
  lastEvaluatedAt: string | null;
  cooldownUntil: number;
}

export class EvolutionEngine {
  private records: DecisionRecord[] = [];
  private changelog: ChangeLogEntry[] = [];
  private seq = 0;
  private lastEvaluatedAt: string | null = null;
  private cooldownUntil = 0;
  /** 上一次评估产生的全部变更，用于整体回滚 */
  private lastBatch: { param: string; before: number }[] = [];

  constructor(
    private readonly dataDir: string,
    private config: AppConfig,
    private readonly onConfigChange: (next: AppConfig) => void,
  ) {
    this.load();
  }

  useConfig(config: AppConfig): void {
    this.config = config;
  }

  private get path(): string {
    return join(this.dataDir, "evolution.json");
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as Persisted;
      this.records = Array.isArray(data.records) ? data.records : [];
      this.changelog = Array.isArray(data.changelog) ? data.changelog : [];
      this.seq = Number(data.seq ?? this.records.length);
      this.lastEvaluatedAt = data.lastEvaluatedAt ?? null;
      this.cooldownUntil = Number(data.cooldownUntil ?? 0);
    } catch (err) {
      log.warn("evolution.json 解析失败，从空学习记录开始: %s", (err as Error).message);
    }
  }

  /**
   * 落盘。evolution.persist = false 时只留内存、不写文件 ——
   * 这个开关必须真的挡住写入，否则「关闭持久化」就是一句空话。
   */
  private persist(): void {
    if (!this.config.evolution.persist) return;
    mkdirSync(this.dataDir, { recursive: true });
    const data: Persisted = {
      seq: this.seq,
      records: this.records.slice(-MAX_RECORDS),
      changelog: this.changelog.slice(-MAX_CHANGELOG),
      lastEvaluatedAt: this.lastEvaluatedAt,
      cooldownUntil: this.cooldownUntil,
    };
    writeFileSync(this.path, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  get evolution(): EvolutionSection {
    return this.config.evolution;
  }

  /** 记一次决策。 */
  record(input: Omit<DecisionRecord, "id" | "at"> & { at?: string }): void {
    if (!this.evolution.enabled) return;
    this.seq += 1;
    this.records.push({ ...input, id: this.seq, at: input.at ?? new Date().toISOString() });
    if (this.records.length > MAX_RECORDS) this.records = this.records.slice(-MAX_RECORDS);
    this.persist();
  }

  /** 结算一批到期决策：用 horizon 之后的行情算出实际收益与超额。 */
  settle(
    prices: Map<string, number[]>,
    options: { advanceBars: number; horizonBars?: number; equalWeight?: number },
  ): number {
    if (!this.evolution.enabled) return 0;
    const horizon = options.horizonBars ?? this.evolution.horizonBars;
    let settledCount = 0;

    for (const rec of this.records) {
      if (rec.outcome) continue;
      const entry: number = rec.entryBarIndex ?? 0;
      const target = entry + horizon;
      if (target > options.advanceBars) continue;

      // 组合收益 = Σ 权重 × 标的收益；现金按 0 计
      let ret = 0;
      let adverse = 0;
      const symbols = Object.keys(rec.weights);
      for (const symbol of symbols) {
        const w = rec.weights[symbol] ?? 0;
        const series = prices.get(symbol);
        const from = rec.refPrices[symbol];
        if (!series || !from) continue;
        const p1 = series[Math.min(target, series.length - 1)];
        const p0 = series[entry];
        if (!p1 || !p0) continue;
        const symRet = (p1 - p0) / p0;
        ret += w * symRet;
        // 最大不利偏移：窗口内最差的一次
        let worst = 0;
        for (let i = entry; i <= target && i < series.length; i++) {
          const pi = series[i]!;
          const r = (pi - p0) / p0;
          if (r < worst) worst = r;
        }
        adverse += w * worst;
      }
      const outcome: DecisionOutcome = {
        horizonBars: horizon,
        returnPct: Number(ret.toFixed(6)),
        alpha: Number((ret - (options.equalWeight ?? 0)).toFixed(6)),
        maxAdverse: Number(adverse.toFixed(6)),
        settledAt: new Date().toISOString(),
      };
      rec.outcome = outcome;
      settledCount += 1;
    }
    if (settledCount > 0) {
      this.persist();
      log.info("结算了 %d 笔决策，当前样本 %d 笔", settledCount, this.stats().settled);
    }
    return settledCount;
  }

  /** 统计（自我认知的基础）。 */
  stats(): EvolutionStats {
    const settled = this.records.filter((r) => r.outcome);
    const pending = this.records.length - settled.length;
    if (settled.length === 0) {
      return {
        total: this.records.length,
        settled: 0,
        pending,
        winRate: 0,
        avgReturn: 0,
        avgAlpha: 0,
        beatRate: 0,
        bestSymbol: null,
        bestSymbolAlpha: 0,
        lastEvaluatedAt: this.lastEvaluatedAt,
        cooldownUntil: this.cooldownUntil > Date.now() ? new Date(this.cooldownUntil).toISOString() : null,
        samplesNeeded: Math.max(0, this.evolution.minSamples - 0),
      };
    }
    const avgReturn = avg(settled.map((r) => r.outcome!.returnPct));
    const avgAlpha = avg(settled.map((r) => r.outcome!.alpha));
    const winRate = settled.filter((r) => r.outcome!.returnPct > 0).length / settled.length;
    const beatRate = settled.filter((r) => r.outcome!.alpha > 0).length / settled.length;

    // 按标的聚合超额，找表现最好的
    const perSymbol = new Map<string, { sum: number; n: number }>();
    for (const r of settled) {
      for (const [symbol, w] of Object.entries(r.weights)) {
        if (w <= 0) continue;
        const cur = perSymbol.get(symbol) ?? { sum: 0, n: 0 };
        cur.sum += r.outcome!.alpha * w;
        cur.n += 1;
        perSymbol.set(symbol, cur);
      }
    }
    let bestSymbol: string | null = null;
    let bestSymbolAlpha = 0;
    for (const [symbol, v] of perSymbol) {
      const a = v.sum / Math.max(1, v.n);
      if (a > bestSymbolAlpha) {
        bestSymbol = symbol;
        bestSymbolAlpha = Number(a.toFixed(6));
      }
    }

    return {
      total: this.records.length,
      settled: settled.length,
      pending,
      winRate: Number(winRate.toFixed(4)),
      avgReturn: Number(avgReturn.toFixed(6)),
      avgAlpha: Number(avgAlpha.toFixed(6)),
      beatRate: Number(beatRate.toFixed(4)),
      bestSymbol,
      bestSymbolAlpha,
      lastEvaluatedAt: this.lastEvaluatedAt,
      cooldownUntil: this.cooldownUntil > Date.now() ? new Date(this.cooldownUntil).toISOString() : null,
      samplesNeeded: Math.max(0, this.evolution.minSamples - settled.length),
    };
  }

  /**
   * 评估一轮：样本够 + 不在冷却期 + 有建议时才动手。
   * force=true 时跳过样本与冷却限制（页面上的「立即评估」按钮用）。
   */
  evaluate(force = false): ChangeLogEntry[] {
    const evo = this.evolution;
    if (!evo.enabled && !force) return [];
    const stats = this.stats();
    const now = Date.now();

    if (!force) {
      if (stats.settled < evo.minSamples) {
        log.debug("样本不足（%d/%d），本次不调参", stats.settled, evo.minSamples);
        return [];
      }
      if (this.cooldownUntil > now) return [];
    }

    const proposals = proposeTuning(stats, this.config, {
      tunable: evo.tunable,
      maxChangeRatio: evo.maxChangeRatio,
    });
    this.lastEvaluatedAt = new Date().toISOString();
    if (proposals.length === 0) {
      this.persist();
      return [];
    }

    const applied: ChangeLogEntry[] = [];
    const batch: { param: string; before: number }[] = [];
    const next: AppConfig = structuredClone(this.config);
    for (const p of proposals) {
      const rule = PARAM_RULE_BY_KEY[p.param];
      if (!rule) continue;
      const before = rule.read(this.config);
      if (Math.abs(before - p.value) < 1e-9) continue;
      rule.write(next, p.value);
      // 快线必须小于慢线，否则策略算不出来
      if (p.param === "strategy.fastWindow" && next.strategy.fastWindow >= next.strategy.slowWindow) continue;
      const entry: ChangeLogEntry = {
        at: new Date().toISOString(),
        param: p.param,
        before,
        after: p.value,
        reason: p.reason,
        evidence: { settled: stats.settled, avgAlpha: stats.avgAlpha, beatRate: stats.beatRate },
        reverted: false,
      };
      this.changelog.push(entry);
      applied.push(entry);
      batch.push({ param: p.param, before });
      log.info("自我进化：%s %s -> %s（%s）", paramLabel(p.param), before, p.value, p.reason);
    }

    if (applied.length > 0) {
      this.lastBatch = batch;
      this.cooldownUntil = now + evo.cooldownMs;
      this.onConfigChange(next);
    }
    if (this.changelog.length > MAX_CHANGELOG) this.changelog = this.changelog.slice(-MAX_CHANGELOG);
    this.persist();
    return applied;
  }

  /**
   * 回滚上一次评估产生的全部变更（一次评估可能同时动了多个参数）。
   * 没有可回滚的变更时返回 null。
   */
  rollback(): ChangeLogEntry[] | null {
    if (this.lastBatch.length === 0) return null;
    const next: AppConfig = structuredClone(this.config);
    const reverted: ChangeLogEntry[] = [];
    // 逆序恢复，避免参数间的相对关系被破坏
    for (const item of [...this.lastBatch].reverse()) {
      const rule = PARAM_RULE_BY_KEY[item.param];
      if (!rule) continue;
      rule.write(next, item.before);
      const entry = [...this.changelog].reverse().find((c) => c.param === item.param && !c.reverted);
      if (entry) {
        entry.reverted = true;
        reverted.push(entry);
      }
      log.info("已回滚自我进化变更：%s -> %s", paramLabel(item.param), item.before);
    }
    this.lastBatch = [];
    this.onConfigChange(next);
    this.persist();
    return reverted;
  }

  view(): EvolutionView {
    const stats = this.stats();
    return {
      enabled: this.evolution.enabled,
      stats,
      changelog: [...this.changelog].reverse(),
      recentDecisions: this.records.slice(-20).reverse().map((r) => ({ ...r, symbols: Object.keys(r.weights) })),
      limits: {
        minSamples: this.evolution.minSamples,
        cooldownMs: this.evolution.cooldownMs,
        maxChangeRatio: this.evolution.maxChangeRatio,
        horizonBars: this.evolution.horizonBars,
        tunable: this.evolution.tunable,
      },
    };
  }
}

/** 白名单表：只暴露读写接口，范围约束已在 proposeTuning 里生效。 */
const PARAM_RULE_BY_KEY: Record<
  string,
  { read: (c: AppConfig) => number; write: (c: AppConfig, v: number) => void }
> = Object.fromEntries(
  Object.entries(PARAM_RULES).map(([k, v]) => [k, { read: v.read, write: v.write }]),
);

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}