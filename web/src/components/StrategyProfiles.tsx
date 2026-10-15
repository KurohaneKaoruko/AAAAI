/**
 * 策略列表（策略页左栏）。
 *
 * 交互约定：
 * - 点条目 = 选中并编辑（唯一的选择入口；不再另设「正在编辑」下拉，
 *   两处选择并存时用户会不知道自己改的是哪一条）；
 * - 危险操作（删除默认策略）由服务端拒绝，这里直接置灰并给出原因。
 */

import { useState } from "react";
import { api } from "../api";
import type { StrategyProfile } from "../types";
import { Button, Empty, Notice, SelectField } from "./ui";
import { SOURCE_ZH } from "./DecisionSourceSwitch";

/** 一行字概括这条策略（下方参数说明也用它）。 */
export function describe(s: StrategyProfile): string {
  const parts: string[] = [];
  if (s.decisionSource === "rules") parts.push(`量化交易 · 双均线 ${s.fastWindow}/${s.slowWindow}`);
  else parts.push(SOURCE_ZH[s.decisionSource]);
  if (s.selfAllocating) parts.push(`AI 选资产 ≤${s.maxPositions}`);
  return parts.join(" · ");
}

export function StrategyList({
  items,
  defaultId,
  selectedId,
  onSelect,
  onChanged,
  running,
}: {
  items: StrategyProfile[];
  defaultId: string;
  selectedId: string;
  onSelect: (id: string) => void;
  onChanged: () => void | Promise<void>;
  running?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  const guard = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const add = async () => {
    const n = name.trim();
    if (!n) return;
    await guard(async () => {
      // 复制当前选中那条作为模板：新建时少填一遍参数
      const base = items.find((i) => i.id === selectedId);
      await api.createStrategy({
        name: n,
        ...(base
          ? {
              decisionSource: base.decisionSource,
              fastWindow: base.fastWindow,
              slowWindow: base.slowWindow,
              maxTargetWeight: base.maxTargetWeight,
              selfAllocating: base.selfAllocating,
              maxPositions: base.maxPositions,
              maxGrossExposure: base.maxGrossExposure,
              allocationInterval: base.allocationInterval,
              hybridInfluence: base.hybridInfluence,
            }
          : {}),
      });
    });
    setAdding(false);
    setName("");
  };

  return (
    <>
      <div className="strategy-list">
        {items.map((s) => {
          const isDefault = s.id === defaultId;
          const on = s.id === selectedId;
          return (
            <div
              key={s.id}
              className={`strategy-card ${on ? "strategy-card-on" : ""}`}
              onClick={() => onSelect(s.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(s.id);
                }
              }}
            >
              <div className="strategy-card-head">
                <span className="strategy-card-name">{s.name}</span>
                {isDefault && <span className="chip chip-sm chip-accent">默认</span>}
              </div>
              <div className="strategy-card-meta">{describe(s)}</div>
              <div className="strategy-card-actions" onClick={(e) => e.stopPropagation()}>
                {!isDefault && (
                  <Button
                    small
                    variant="ghost"
                    disabled={running}
                    title="设为默认：单次运行与对照实验使用它"
                    onClick={() => void guard(() => api.setDefaultStrategy(s.id))}
                  >
                    设为默认
                  </Button>
                )}
                <Button
                  small
                  variant="ghost"
                  disabled={running}
                  onClick={() => void guard(() => api.duplicateStrategy(s.id))}
                >
                  复制
                </Button>
                <Button
                  small
                  variant="ghost"
                  disabled={running}
                  onClick={() => {
                    const next = prompt("重命名策略", s.name);
                    if (next?.trim()) void guard(() => api.updateStrategy(s.id, { name: next.trim() }));
                  }}
                >
                  重命名
                </Button>
                <Button
                  small
                  variant="ghost"
                  disabled={running || isDefault || items.length <= 1}
                  title={isDefault ? "默认策略不能删除" : items.length <= 1 ? "至少保留一条" : ""}
                  onClick={() => {
                    if (confirm(`删除策略「${s.name}」？引用它的机器人会自动改用默认策略。`)) {
                      void guard(() => api.deleteStrategy(s.id));
                    }
                  }}
                >
                  删除
                </Button>
              </div>
            </div>
          );
        })}
        {items.length === 0 && <Empty>还没有策略。点下面的「新建策略」建一条。</Empty>}
      </div>

      <div className="btn-row" style={{ marginTop: 10 }}>
        {adding ? (
          <>
            <input
              autoFocus
              value={name}
              placeholder="策略名称，如：BTC 趋势跟踪"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void add();
                if (e.key === "Escape") setAdding(false);
              }}
            />
            <Button small variant="primary" disabled={!name.trim()} onClick={() => void add()}>
              创建
            </Button>
            <Button small variant="ghost" onClick={() => setAdding(false)}>
              取消
            </Button>
          </>
        ) : (
          <Button small onClick={() => setAdding(true)}>
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
