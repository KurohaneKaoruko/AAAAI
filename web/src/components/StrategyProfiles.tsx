/**
 * 策略列表：把「策略」做成可管理的实体。
 *
 * 为什么要有它：以前策略参数只活在全局配置里，机器人各自复制一份覆盖参数，
 * 于是同一套思路想在两个机器人上跑就得填两遍，改一处漏一处。
 * 现在：建一次 → 起名 → 多个机器人引用同一个 id；改一处，全体引用生效。
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { DecisionSource, StrategyProfile } from "../types";
import { Button, Empty, Notice, SelectField, TextField } from "./ui";
import { SOURCE_ZH } from "./DecisionSourceSwitch";

export function StrategyProfiles({ store }: { store: import("../state/useAppStore").AppStore }) {
  const [items, setItems] = useState<StrategyProfile[]>([]);
  const [defaultId, setDefaultId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [rename, setRename] = useState("");

  const reload = useCallback(async () => {
    try {
      const d = await api.strategies();
      setItems(d.strategies);
      setDefaultId(d.defaultId);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 当前面板上选中的是哪条（默认策略始终跟着 config.strategy）。 */
  const selected = items.find((s) => s.id === defaultId) ?? items[0];

  const add = async () => {
    const name = rename.trim();
    if (!name) return;
    setCreating(false);
    try {
      // 复制当前默认策略作为模板，改起来少填一遍
      await api.createStrategy({ name, ...(selected ? templateOf(selected) : {}), note: "" });
      setRename("");
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <div className="hint-line" style={{ marginBottom: 10 }}>
        策略是独立的一条记录：可以建多条（比如「激进趋势」「保守网格」），机器人各自引用一条。
        修改某条策略会立刻影响所有引用它的机器人。
      </div>

      <div className="strategy-list">
        {items.map((s) => (
          <div className={`strategy-row ${s.id === defaultId ? "is-default" : ""}`} key={s.id}>
            <div className="strategy-main">
              <span className="strategy-name">{s.name}</span>
              {s.id === defaultId && <span className="badge badge-idle">默认</span>}
              <span className="dim small mono">{SOURCE_ZH[s.decisionSource] ?? s.decisionSource}</span>
              {s.decisionSource === "rules" && (
                <span className="dim small">
                  双均线 {s.fastWindow}/{s.slowWindow} · 仓位上限于 {Math.round(s.maxTargetWeight * 100)}%
                </span>
              )}
              {s.selfAllocating && (
                <span className="dim small">
                  AI 选资产 · 最多 {s.maxPositions} 个 · 总仓位 {Math.round(s.maxGrossExposure * 100)}%
                </span>
              )}
              {s.decisionSource === "hybrid" && (
                <span className="dim small">影响力 {Math.round(s.hybridInfluence * 100)}%</span>
              )}
            </div>
            <div className="strategy-actions">
              {s.id !== defaultId && (
                <Button
                  small
                  onClick={async () => {
                    await api.setDefaultStrategy(s.id).catch((e) => setError((e as Error).message));
                    await reload();
                  }}
                >
                  设为默认
                </Button>
              )}
              <Button
                small
                onClick={async () => {
                  await api.duplicateStrategy(s.id).catch((e) => setError((e as Error).message));
                  await reload();
                }}
              >
                复制
              </Button>
              <Button
                small
                variant="ghost"
                onClick={async () => {
                  const next = prompt(`重命名策略「${s.name}」`, s.name);
                  if (next && next.trim()) {
                    await api.updateStrategy(s.id, { name: next.trim() }).catch((e) => setError((e as Error).message));
                    await reload();
                  }
                }}
              >
                重命名
              </Button>
              <Button
                small
                variant="danger"
                disabled={s.id === defaultId}
                onClick={async () => {
                  if (!confirm(`删除策略「${s.name}」？引用它的机器人会自动改用默认策略。`)) return;
                  await api.deleteStrategy(s.id).catch((e) => setError((e as Error).message));
                  await reload();
                }}
              >
                删除
              </Button>
            </div>
          </div>
        ))}
      </div>

      {items.length === 0 && <Empty>还没有策略。点「新建策略」建一条。</Empty>}

      <div className="btn-row" style={{ marginTop: 10 }}>
        {creating ? (
          <>
            <TextField label="" value={rename} onChange={setRename} placeholder="策略名称，如：BTC 趋势跟踪" />
            <Button variant="primary" small onClick={() => void add()} disabled={!rename.trim()}>
              创建
            </Button>
            <Button small variant="ghost" onClick={() => setCreating(false)}>
              取消
            </Button>
          </>
        ) : (
          <Button
            small
            onClick={() => {
              setCreating(true);
              setRename("");
            }}
          >
            + 新建策略
          </Button>
        )}
      </div>

      {error && (
        <Notice tone="error" onClose={() => setError(null)}>
          {error}
        </Notice>
      )}
    </>
  );
}

/** 复制时只带策略参数（名字/备注另填）。 */
function templateOf(p: StrategyProfile): Record<string, unknown> {
  return {
    decisionSource: p.decisionSource,
    fastWindow: p.fastWindow,
    slowWindow: p.slowWindow,
    maxTargetWeight: p.maxTargetWeight,
    selfAllocating: p.selfAllocating,
    maxPositions: p.maxPositions,
    maxGrossExposure: p.maxGrossExposure,
    allocationInterval: p.allocationInterval,
    hybridInfluence: p.hybridInfluence,
    hybridAnalysisTtlMs: p.hybridAnalysisTtlMs,
    note: p.note,
  };
}

/** 策略选择器（机器人表单用）。 */
export function StrategyPicker({
  items,
  value,
  onChange,
}: {
  items: StrategyProfile[];
  value?: string;
  onChange: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <SelectField
      label="策略"
      value={value ?? ""}
      options={items.map((s) => ({ value: s.id, label: describe(s) }))}
      onChange={onChange}
    />
  );
}

/** 一行话概括一条策略，便于在下拉里挑。 */
export function describe(s: StrategyProfile): string {
  const parts: string[] = [s.name];
  parts.push(s.decisionSource === "rules" ? `量化 ${s.fastWindow}/${s.slowWindow}` : SOURCE_ZH[s.decisionSource]);
  if (s.selfAllocating) parts.push(`AI 选资产 ${s.maxPositions} 个`);
  return parts.join(" · ");
}
