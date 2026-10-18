/**
 * 显示偏好的浏览器接线：localStorage 读写 + <html data-updown> 应用 + React 订阅。
 *
 * 单独成文件的原因：display.ts 要保持纯逻辑（测试直接引用，不拖 DOM / React）。
 */

import { useSyncExternalStore } from "react";
import {
  getDisplayPrefs,
  parseDisplayPrefs,
  setDisplayPrefs,
  subscribeDisplayPrefs,
  type DisplayPrefs,
} from "./display";

const STORAGE_KEY = "aaaai.display";

/** 启动时调用一次（main.tsx）：先读存储再渲染，首屏就是用户选的颜色。 */
export function initDisplayPrefs(): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) setDisplayPrefs(parseDisplayPrefs(JSON.parse(raw)));
  } catch {
    /* 存储不可用或数据坏了：用默认值，不阻塞启动 */
  }
  applyUpDown();
  subscribeDisplayPrefs(() => {
    applyUpDown();
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(getDisplayPrefs()));
    } catch {
      /* 隐私模式等写不进去：本次会话仍然生效 */
    }
  });
}

function applyUpDown(): void {
  document.documentElement.dataset.updown = getDisplayPrefs().upDown;
}

/** React 订阅口：价格符号改的是已渲染的文本，组件必须跟着重渲染。 */
export function useDisplayPrefs(): DisplayPrefs {
  return useSyncExternalStore(subscribeDisplayPrefs, getDisplayPrefs);
}
