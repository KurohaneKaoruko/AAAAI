/**
 * 危险操作二次确认弹窗。
 *
 * 之前散落各页的是 window.confirm：样式与全站脱节、文案没法排版，
 * 且浏览器可能勾「禁止此页面再显示对话框」—— 一勾，删除就变成了单击直达。
 * 换成自绘弹窗后：焦点落在取消按钮上（手抖回车不会触发危险操作），
 * Esc 也能退出。
 */

import { useEffect, useRef } from "react";
import { Button } from "./ui";

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = "确认",
  danger = true,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  /** 危险操作（删除/清空）确认按钮用红；普通确认用主色 */
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // 打开时焦点放「取消」：键盘党连按回车也不会误删
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="confirm-overlay" onClick={busy ? undefined : onCancel} role="presentation">
      <div
        className="confirm-box"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="confirm-title">
          {danger && <span className="confirm-mark">⚠</span>}
          {title}
        </h3>
        <p className="confirm-msg">{message}</p>
        <div className="confirm-actions">
          <Button onClick={onCancel} disabled={busy} domRef={cancelRef}>
            取消
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} busy={busy} disabled={busy}>
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}
