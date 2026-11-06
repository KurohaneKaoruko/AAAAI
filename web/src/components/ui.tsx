/** 共享 UI 原子组件：面板、表单、按钮、徽章、表格、空态、提示条。 */

import { useEffect, useState, type ReactNode, type Ref } from "react";
import { Select, type SelectOption } from "./Select";

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-head">
          <div>
            <h2 className="panel-title">{title}</h2>
            {subtitle && <span className="panel-sub">{subtitle}</span>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <FieldLabel label={label} hint={hint} required={required} />
      {children}
    </label>
  );
}

/**
 * 字段标题行：标题独占，描述跟在后面但**永不换行**。
 *
 * 之前 label 与 hint 同处一行且都允许折行：像「每标的 K 线数量」这种标题
 * 会被长描述挤成两行，同一行的输入框高低不齐。现在标题 nowrap（候选里省略号），
 * 描述单行省略并用 title 提示全文，保证同一行字段的输入框基线对齐。
 */
function FieldLabel({ label, hint, required }: { label: string; hint?: string; required?: boolean }) {
  return (
    <span className="field-label">
      <span className="field-label-text">
        {label}
        {required && (
          <em className="field-required" aria-label="必填">
            *
          </em>
        )}
      </span>
      {hint && (
        <em className="field-hint" title={hint}>
          {hint}
        </em>
      )}
    </span>
  );
}

/**
 * 自定义控件（如下拉框）的容器。
 *
 * 不能用 <label> 包裹：label 会把内部任意点击转发给它关联的控件
 * （这里是下拉触发按钮），导致「点选项 -> setOpen(false) -> 触发器 toggle -> 又打开」。
 */
export function FieldBox({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <FieldLabel label={label} hint={hint} required={required} />
      {children}
    </div>
  );
}

export function NumberField({
  label,
  hint,
  required,
  value,
  onChange,
  step = 1,
  min,
  max,
  suffix,
  commitOn = "change",
}: {
  label: string;
  hint?: string;
  required?: boolean;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  /**
   * 提交时机：change = 每次合法输入立即提交（本地表单用）；
   * blur = 失焦/回车才提交（onChange 直连保存接口时必须用它——
   * 否则每敲一个键就 PATCH 一次，中间值全写进配置，toast 也会刷屏）。
   */
  commitOn?: "change" | "blur";
}) {
  /**
   * 输入框保留一份「正在输入」的字符串。
   *
   * 以前 value 直接绑 number：想从 100000 改成 50000，全选删空的一瞬间
   * Number("") = 0 就把表单写成 0，接着输入的 5 变成在 0 后面追加；
   * 输入 "0." 也会被立刻改回 "0"，小数点根本打不出来。
   * 现在空串只留在本地，合法数字才向上提交；失焦时非法/越界再回填。
   */
  const [text, setText] = useState(() => String(value));
  useEffect(() => {
    setText((prev) => {
      const n = Number(prev);
      return prev.trim() !== "" && Number.isFinite(n) && n === value ? prev : String(value);
    });
  }, [value]);

  const commit = () => {
    const n = Number(text);
    if (text.trim() === "" || !Number.isFinite(n)) {
      setText(String(value));
      return;
    }
    const clamped = Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, n));
    // change 模式下合法输入已实时提交，这里只补截断场景；
    // blur 模式下这是唯一提交点，值有变就提交。
    if (commitOn === "blur" ? clamped !== value : clamped !== n) onChange(clamped);
    setText(String(clamped));
  };

  return (
    <Field label={label} hint={hint} required={required}>
      <div className="input-affix">
        <input
          type="number"
          value={text}
          step={step}
          min={min}
          max={max}
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            if (commitOn === "blur") return; // 输入只改本地草稿，commit 时才提交
            if (next.trim() === "") return;
            const v = Number(next);
            if (Number.isFinite(v)) onChange(v);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur(); // 回车 = 结束输入，走同一条 commit 路径
            }
          }}
        />
        {suffix && <span className="affix">{suffix}</span>}
      </div>
    </Field>
  );
}

export function TextField({
  label,
  hint,
  required,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  hint?: string;
  required?: boolean;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <Field label={label} hint={hint} required={required}>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

export function SelectField<T extends string>({
  label,
  hint,
  required,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <FieldBox label={label} hint={hint} required={required}>
      <Select value={value} options={options} onChange={onChange} />
    </FieldBox>
  );
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
  danger = false,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  danger?: boolean;
}) {
  return (
    <label className={`toggle ${checked && danger ? "toggle-danger" : ""}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" />
      <span className="toggle-text">
        {label}
        {hint && <em>{hint}</em>}
      </span>
    </label>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  busy,
  type = "button",
  small = false,
  title,
  domRef,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  busy?: boolean;
  type?: "button" | "submit";
  small?: boolean;
  title?: string;
  domRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={domRef}
      type={type}
      className={`btn btn-${variant} ${small ? "btn-sm" : ""}`}
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
    >
      {busy && <span className="spinner" />}
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "up" | "down" | "warn" | "accent";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Notice({
  tone = "info",
  children,
  onClose,
}: {
  tone?: "info" | "success" | "warn" | "error";
  children: ReactNode;
  onClose?: () => void;
}) {
  return (
    <div className={`notice notice-${tone}`}>
      <span>{children}</span>
      {onClose && (
        <button type="button" className="notice-close" onClick={onClose}>
          ×
        </button>
      )}
    </div>
  );
}

export function Row({ children, gap = 12 }: { children: ReactNode; gap?: number }) {
  return (
    <div className="row" style={{ gap }}>
      {children}
    </div>
  );
}