/**
 * 自绘下拉框（Select）。
 *
 * 为什么不用原生 <select>：
 * 1) 原生弹出层由操作系统绘制，CSS 无法控制样式；
 * 2) 弹出层固定为浅色，在暗色主题下必然割裂；
 * 3) 选项数量多时原生下拉没有搜索与描述位。
 *
 * 实现：fixed 定位的浮层（避免被面板 overflow 裁剪）+ 键盘导航 + 视口边界自适应。
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder = "请选择",
  disabled = false,
  id,
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 200, dropUp: false });

  const current = options.find((o) => o.value === value);

  // 关闭时重置高亮到当前值
  useEffect(() => {
    if (open) setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", () => setOpen(false));
    window.addEventListener("scroll", () => setOpen(false), true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 浮层定位：贴近触发器，底部空间不足则向上展开
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const margin = 8;
      const estimatedHeight = Math.min(options.length * 38 + 12, 300);
      const below = window.innerHeight - r.bottom - margin;
      const dropUp = below < estimatedHeight && r.top > below;
      setPos({
        top: dropUp ? r.top - Math.min(estimatedHeight, r.top - margin) : r.bottom + 6,
        left: r.left,
        width: r.width,
        dropUp,
      });
    };
    place();
    const ro = new ResizeObserver(place);
    if (triggerRef.current) ro.observe(triggerRef.current);
    return () => ro.disconnect();
  }, [open, options.length]);

  const commit = (index: number) => {
    const opt = options[index];
    if (!opt) return;
    onChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) return setOpen(true);
        setActive((i) => Math.min(options.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!open) return setOpen(true);
        setActive((i) => Math.max(0, i - 1));
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (open) commit(active);
        else setOpen(true);
        break;
      case "Home":
        if (open) {
          e.preventDefault();
          setActive(0);
        }
        break;
      case "End":
        if (open) {
          e.preventDefault();
          setActive(options.length - 1);
        }
        break;
    }
  };

  return (
    <div className="select" ref={rootRef}>
      <button
        type="button"
        id={id}
        ref={triggerRef}
        className={`select-trigger ${open ? "select-open" : ""}`}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-activedescendant={open ? `opt-${active}` : undefined}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onKeyDown}
      >
        <span className={`select-value ${current ? "" : "select-placeholder"}`}>
          {current?.label ?? placeholder}
        </span>
        <span className="select-caret" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={menuRef}
          className="select-menu"
          role="listbox"
          style={{
            top: pos.top,
            left: pos.left,
            minWidth: pos.width,
            maxHeight: pos.dropUp ? undefined : Math.max(160, window.innerHeight - pos.top - 12),
          }}
        >
          {options.map((o, i) => (
            <div
              key={o.value}
              id={`opt-${i}`}
              role="option"
              aria-selected={o.value === value}
              className={`select-option ${o.value === value ? "select-selected" : ""} ${i === active ? "select-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(i)}
            >
              <span className="select-option-label">{o.label}</span>
              {o.hint && <span className="select-option-hint">{o.hint}</span>}
              {o.value === value && <span className="select-check">✓</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}