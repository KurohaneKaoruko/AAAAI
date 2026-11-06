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
import { ConfirmDialog } from "./ConfirmDialog";
import { SOURCE_ZH } from "./DecisionSourceSwitch";

/** 一行字概括这条策略（下方参数说明也用它）。 */
export function describe(s: StrategyProfile): string {
  const parts: string[] = [];
  if (s.decisionSource === "rules") {
    if (s.engine === "breakout") {
      parts.push(`量化交易 · 唐奇安突破 入场${s.slowWindow}/离场${s.fastWindow}`);
    } else if (s.engine === "meanrev") {
      parts.push(`量化交易 · 均值回归 均值${s.slowWindow}/过滤${s.fastWindow}`);
    } else if (s.engine === "custom") {
      parts.push("量化交易 · 自定义代码");
    } else {
      parts.push(`量化交易 · ${s.engine === "adaptive" ? "自适应趋势" : "双均线"} ${s.fastWindow}/${s.slowWindow}`);
    }
  } else parts.push(SOURCE_ZH[s.decisionSource]);
  if (s.allowShort) parts.push("双向（仅合约）");
  if (s.selfAllocating) parts.push(`${s.decisionSource === "rules" ? "因子选资产" : "AI 选资产"} ≤${s.maxPositions}`);
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
  /** 就地重命名：不再用 window.prompt —— 弹窗样式与全站脱节，且可能被浏览器禁用。 */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  /** 待确认删除的策略（自绘二次确认，替代 window.confirm） */
  const [confirmDel, setConfirmDel] = useState<StrategyProfile | null>(null);
  const [deleting, setDeleting] = useState(false);

  const guard = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await fn();
      await onChanged();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  const commitRename = async (s: StrategyProfile) => {
    const next = renameValue.trim();
    if (!next || next === s.name) {
      setRenamingId(null);
      return;
    }
    const ok = await guard(() => api.updateStrategy(s.id, { name: next }));
    if (ok) setRenamingId(null);
  };

  const remove = async () => {
    if (!confirmDel) return;
    setDeleting(true);
    const ok = await guard(() => api.deleteStrategy(confirmDel.id));
    setDeleting(false);
    if (ok) setConfirmDel(null);
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
              engine: base.engine,
              fastWindow: base.fastWindow,
              slowWindow: base.slowWindow,
              maxTargetWeight: base.maxTargetWeight,
              allowShort: base.allowShort,
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
                {renamingId === s.id ? (
                  <input
                    autoFocus
                    className="strategy-rename"
                    value={renameValue}
                    aria-label="策略名称"
                    title="回车保存，Esc 取消"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitRename(s);
                      }
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                  />
                ) : (
                  <span className="strategy-card-name">{s.name}</span>
                )}
                {isDefault && <span className="chip chip-sm chip-accent">默认</span>}
              </div>
              <div className="strategy-card-meta">{describe(s)}</div>
              <div className="strategy-card-actions" onClick={(e) => e.stopPropagation()}>
                {!isDefault && (
                  <Button
                    small
                    variant="ghost"
                    disabled={running}
                    title="设为默认：模拟对照使用它"
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
                    setRenameValue(s.name);
                    setRenamingId(s.id);
                  }}
                >
                  重命名
                </Button>
                <Button
                  small
                  variant="danger"
                  disabled={running || isDefault || items.length <= 1}
                  title={isDefault ? "默认策略不能删除" : items.length <= 1 ? "至少保留一条" : ""}
                  onClick={() => setConfirmDel(s)}
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

      <ConfirmDialog
        open={confirmDel !== null}
        title={`删除策略「${confirmDel?.name ?? ""}」？`}
        message="引用这条策略的机器人会自动改用默认策略。策略本身不可恢复，但可以再建一条相同的。"
        confirmText="删除策略"
        busy={deleting}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDel(null)}
      />
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
