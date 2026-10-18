/**
 * 主题：暗色 / 亮色（黑白双主题），持久化到 localStorage。
 *
 * 模块级单例：顶栏快捷开关与设置页各有一个入口，共享同一份状态 ——
 * 谁改了，另一个立刻跟上（useSyncExternalStore 订阅）。
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "aaaai.theme";

let current: Theme = initialTheme();
const listeners = new Set<() => void>();

function initialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = theme;
  window.localStorage.setItem(STORAGE_KEY, theme);
}

function setTheme(next: Theme): void {
  if (next === current) return;
  current = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void } {
  const theme = useSyncExternalStore(subscribe, () => current);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // 首次未手动设置过时，跟随系统偏好变化
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent): void => {
      if (window.localStorage.getItem(STORAGE_KEY)) return;
      setTheme(e.matches ? "light" : "dark");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const toggle = useCallback(() => {
    setTheme(current === "dark" ? "light" : "dark");
  }, []);

  const set = useCallback((t: Theme) => setTheme(t), []);

  return { theme, toggle, setTheme: set };
}
