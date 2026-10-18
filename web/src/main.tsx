import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initDisplayPrefs } from "./lib/useDisplayPrefs";
import "./styles.css";

// 首屏之前落地显示偏好（涨跌颜色 / 价格符号），避免先闪一下默认色再跳
initDisplayPrefs();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
