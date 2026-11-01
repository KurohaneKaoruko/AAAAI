/**
 * 数值闪烁：轮询/SSE 的新值到达时，把变化的方向色闪一下再淡出。
 *
 * 量化界面整屏都是数字，「变了」比「是多少」更难看见 ——
 * 一条 0.9s 的高亮衰减让眼睛先落在刚动的格子上。
 * prefers-reduced-motion 的用户由 CSS 侧退化为无动画，这里照常工作。
 *
 * 用法：const cls = useFlash(value); → <span className={`mono ${cls}`}>{...}</span>
 * 首次渲染不闪（没有「旧值」可比）。
 */

import { useEffect, useRef, useState } from "react";

export function useFlash(value: number, eps = 1e-9): string {
  const prev = useRef<number | null>(null);
  const [cls, setCls] = useState("");

  useEffect(() => {
    const old = prev.current;
    prev.current = value;
    if (old === null || Math.abs(value - old) < eps) return;
    setCls(value > old ? "flash-up" : "flash-down");
    // 动画播完把类摘掉，下次变化才能重新触发
    const t = setTimeout(() => setCls(""), 950);
    return () => clearTimeout(t);
  }, [value, eps]);

  return cls;
}
