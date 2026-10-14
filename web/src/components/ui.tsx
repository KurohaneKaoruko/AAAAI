/** 共享 UI 原子组件：面板、表单、按钮、徽章、表格、空态、提示条。 */

import type { ReactNode } from "react";
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
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint && <em className="field-hint">{hint}</em>}
      </span>
      {children}
    </label>
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
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <span className="field-label">
        {label}
        {hint && <em className="field-hint">{hint}</em>}
      </span>
      {children}
    </div>
  );
}

export function NumberField({
  label,
  hint,
  value,
  onChange,
  step = 1,
  min,
  max,
  suffix,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="input-affix">
        <input
          type="number"
          value={value}
          step={step}
          min={min}
          max={max}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(v);
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
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <Field label={label} hint={hint}>
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
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <FieldBox label={label} hint={hint}>
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
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  busy?: boolean;
  type?: "button" | "submit";
  small?: boolean;
  title?: string;
}) {
  return (
    <button
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