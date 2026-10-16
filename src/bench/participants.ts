/**
 * 对照实验的参赛者：把「机器人 / 量化策略 / 模型实例 / 动量基线」摊成一张统一清单。
 *
 * 以前参赛者只能是模型实例 —— 想比"两条量化策略谁更赚"，只能手工改全局配置
 * 各跑一遍，既不严谨（两次拉到的行情都可能不同）也没法并排看。
 * 现在界面只负责勾选 key，服务端按 key 解析成选手，
 * 于是"页面上能勾的"与"服务端真会跑的"必然是同一份判定，不会出现
 * "勾了却跑不了"或者"跑起来了但用的不是你以为的那条策略"。
 */

import type { DecisionSource } from "../configSchema.js";
import { strategyFields, type StrategyProfile } from "../strategies/profileStore.js";
import type { BotConfig } from "../bots/types.js";
import type { LlmManager, ModelKind } from "../llm/llmManager.js";
import type { LLMClient } from "../llm/llmClient.js";
import type { RunnerSpec } from "./comparison.js";

export type ParticipantType = "baseline" | "strategy" | "bot" | "model";

/** 页面摊开给人看的策略参数：比的是什么，必须一眼看见。 */
export interface ParticipantParams {
  fastWindow: number;
  slowWindow: number;
  maxTargetWeight: number;
  maxPositions: number;
  selfAllocating: boolean;
}

export interface Participant {
  /** 提交给服务端的唯一键：`baseline` / `bot:<id>` / `strategy:<id>` / `model:<id>` */
  key: string;
  type: ParticipantType;
  name: string;
  /** 来源说明：机器人 / 策略 / 模型 */
  detail: string;
  /** 这条选手的决策来源（对照实验里每条只跑自己那一路） */
  decisionSource: DecisionSource;
  params: ParticipantParams;
  /** 用到的模型（没有则为空） */
  models: string[];
  /** 不能参赛的原因；为空即可参赛 */
  unavailable?: string;
}

export const SOURCE_LABEL: Record<DecisionSource, string> = {
  rules: "量化交易",
  chat: "对话模型",
  systemone: "决策模型",
  hybrid: "混合决策",
};

const KIND_LABEL: Record<ModelKind, string> = { chat: "对话模型", systemone: "决策模型" };

/** 某条决策来源需要哪几类模型实例（混合决策两端都要）。 */
export function requiredModelKinds(source: DecisionSource): ModelKind[] {
  if (source === "chat") return ["chat"];
  if (source === "systemone") return ["systemone"];
  if (source === "hybrid") return ["chat", "systemone"];
  return [];
}

function paramsOf(p: Partial<StrategyProfile>): ParticipantParams {
  return {
    fastWindow: p.fastWindow ?? 5,
    slowWindow: p.slowWindow ?? 20,
    maxTargetWeight: p.maxTargetWeight ?? 0.5,
    maxPositions: p.maxPositions ?? 3,
    selfAllocating: p.selfAllocating ?? false,
  };
}

/** 参赛者解析需要的依赖（只声明用到的那几个方法，便于测试替身）。 */
export interface ParticipantDeps {
  /** 当前默认策略的字段（模型类选手沿用它） */
  defaultStrategy: StrategyProfile;
  strategies: StrategyProfile[];
  bots: BotConfig[];
  /** 机器人 id -> 它引用的策略 */
  strategyOf: (bot: BotConfig) => StrategyProfile;
  llm: Pick<LlmManager, "list" | "available" | "clientFor">;
  connectionId: string;
  connectionLabel: string;
}

function modelNames(llm: ParticipantDeps["llm"], kinds: ModelKind[], scope?: string[]): string[] {
  const out: string[] = [];
  for (const kind of kinds) {
    const pool = llm
      .available(kind)
      .filter((p) => (scope && scope.length > 0 ? scope.includes(p.id) : true));
    // 与机器人一致：多个实例时只取一个（对照实验要单变量，不能让选手内部再轮换模型）
    const first = pool[0];
    if (first) out.push(`${KIND_LABEL[kind]}·${first.label}`);
  }
  return out;
}

function missingModels(llm: ParticipantDeps["llm"], kinds: ModelKind[], scope?: string[]): string[] {
  return kinds
    .filter((kind) => {
      const pool = llm
        .available(kind)
        .filter((p) => (scope && scope.length > 0 ? scope.includes(p.id) : true));
      return pool.length === 0;
    })
    .map((k) => KIND_LABEL[k]);
}

/** 摊平出全部参赛者（含不可用的，并说明为什么）。 */
export function buildParticipants(deps: ParticipantDeps): Participant[] {
  const out: Participant[] = [];
  const base = deps.defaultStrategy;

  // 1) 参照系：同参数、不调模型。有了它，"比模型"才有意义（否则不知道是模型赚的还是行情赚的）
  out.push({
    key: "baseline",
    type: "baseline",
    name: "动量基线",
    detail: `与默认策略「${base.name}」同样的参数，但不调用任何模型`,
    decisionSource: "rules",
    params: paramsOf(base),
    models: [],
  });

  // 2) 机器人：直接拿配置好的机器人来对照，它用什么策略/模型就用什么
  for (const bot of deps.bots) {
    const sp = deps.strategyOf(bot);
    const kinds = requiredModelKinds(sp.decisionSource);
    let unavailable: string | undefined;
    if (bot.connectionId !== deps.connectionId) {
      unavailable = `连接不同（${deps.connectionLabel}），无法在同一份行情上比较`;
    } else if (!bot.enabled) {
      unavailable = "机器人已停用";
    } else {
      const missing = missingModels(deps.llm, kinds, bot.modelProfileIds);
      if (missing.length > 0) unavailable = `缺少可用的${missing.join(" 与 ")}实例`;
    }
    out.push({
      key: `bot:${bot.id}`,
      type: "bot",
      name: bot.name,
      detail: `机器人 · 策略「${sp.name}」`,
      decisionSource: sp.decisionSource,
      params: paramsOf(sp),
      models: modelNames(deps.llm, kinds, bot.modelProfileIds),
      ...(unavailable ? { unavailable } : {}),
    });
  }

  // 3) 量化策略：策略列表里的每一条都能单独上场（哪怕它平时只被机器人引用）
  for (const sp of deps.strategies) {
    const kinds = requiredModelKinds(sp.decisionSource);
    const missing = missingModels(deps.llm, kinds);
    out.push({
      key: `strategy:${sp.id}`,
      type: "strategy",
      name: sp.name,
      detail: sp.id === deps.defaultStrategy.id ? "策略 · 当前默认" : "策略",
      decisionSource: sp.decisionSource,
      params: paramsOf(sp),
      models: modelNames(deps.llm, kinds),
      ...(missing.length > 0 ? { unavailable: `缺少可用的${missing.join(" 与 ")}实例` } : {}),
    });
  }

  // 4) 模型实例：沿用默认策略的参数，只换"谁来做决策"
  for (const p of deps.llm.list()) {
    let unavailable: string | undefined;
    if (!p.enabled) unavailable = "实例已停用";
    else if (!p.hasKey) unavailable = "还没填 API Key";
    else if (!deps.llm.clientFor(p.id)) unavailable = "实例当前不可用";
    out.push({
      key: `model:${p.id}`,
      type: "model",
      name: p.label,
      detail: `${KIND_LABEL[p.kind]} · ${p.model}`,
      decisionSource: p.kind,
      params: paramsOf(base),
      models: [p.label],
      ...(unavailable ? { unavailable } : {}),
    });
  }

  return out;
}

/** 取某个来源实际要用的模型客户端（每类最多一个，保证单变量）。 */
function clientsFor(
  llm: ParticipantDeps["llm"],
  source: DecisionSource,
  scope?: string[],
): { chat?: LLMClient | null; systemone?: LLMClient | null } {
  const out: { chat?: LLMClient | null; systemone?: LLMClient | null } = {};
  for (const kind of requiredModelKinds(source)) {
    const pool = llm.available(kind).filter((p) => (scope && scope.length > 0 ? scope.includes(p.id) : true));
    const picked = pool[0] ? llm.clientFor(pool[0].id) : null;
    if (kind === "chat") out.chat = picked?.client ?? null;
    else out.systemone = picked?.client ?? null;
  }
  return out;
}

/**
 * 把勾选的 key 解析成参赛选手。
 *
 * 任何一条 key 解析不出来、或解析出来没有可用模型，就直接报错并点名 ——
 * 绝不"悄悄跳过一个"：用户勾了 3 个只跑了 2 个，榜单就是骗人的。
 */
export function resolveRunners(keys: string[], deps: ParticipantDeps): RunnerSpec[] {
  const participants = buildParticipants(deps);
  const byKey = new Map(participants.map((p) => [p.key, p]));
  const runners: RunnerSpec[] = [];

  for (const key of keys) {
    const p = byKey.get(key);
    if (!p) throw new Error(`参赛者不存在或已删除：${key}`);
    if (p.unavailable) throw new Error(`参赛者「${p.name}」不能上场：${p.unavailable}`);

    const modelKey = key.startsWith("model:") ? key.slice("model:".length) : null;
    const botKey = key.startsWith("bot:") ? key.slice("bot:".length) : null;
    const strategyKey = key.startsWith("strategy:") ? key.slice("strategy:".length) : null;
    const bot: BotConfig | undefined = botKey ? deps.bots.find((b) => b.id === botKey) : undefined;
    const profile: StrategyProfile | undefined = strategyKey
      ? deps.strategies.find((s) => s.id === strategyKey)
      : bot
        ? deps.strategyOf(bot)
        : deps.defaultStrategy;

    const source: DecisionSource = p.key === "baseline" ? "rules" : p.decisionSource;
    runners.push({
      id: p.key,
      label: p.type === "model" && modelKey ? `${p.name}` : p.name,
      kind: p.key === "baseline" ? "baseline" : source,
      decisionSource: source,
      strategyPatch: profile && p.key !== "baseline" ? strategyFields(profile) : {},
      ...(modelKey && deps.llm.clientFor(modelKey)
        ? {
            clients:
              source === "chat"
                ? { chat: deps.llm.clientFor(modelKey)!.client }
                : source === "systemone"
                  ? { systemone: deps.llm.clientFor(modelKey)!.client }
                  : {},
          }
        : {}),
      ...(modelKey === null ? { clients: clientsFor(deps.llm, source, bot?.modelProfileIds) } : {}),
      model: p.models[0],
      origin: { type: p.type, key: p.key, name: p.name },
    });
  }

  if (runners.length === 0) throw new Error("还没有勾选任何参赛者");
  return runners;
}

/**
 * 参赛者数量上限：再多流水线并行会互相拖慢，时间呈线性增长。
 *
 * 前端也写着同一个数字（勾选时先拦一道），两边必须一致 ——
 * 否则界面让人勾、服务端却拒。test/bench.test.ts 盯着它们相等。
 */
export const MAX_RUNNERS = 6;
