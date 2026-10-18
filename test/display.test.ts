/**
 * 显示偏好（涨跌颜色 / 价格符号）：纯逻辑 + 界面接线。
 *
 * 锁三件事：
 *  1. 价格符号只改金额前缀 —— 不设符号时输出与从前逐字节一致（默认零变化）；
 *  2. localStorage 里可能是任何东西：坏数据逐字段回退默认；
 *  3. 界面「说」的颜色口径与 styles.css「做」的一致：
 *     行情方向色 --up/--down 可对调，系统状态色 --green/--red 不跟随。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { money, pct, signed } from "../web/src/lib/format.js";
import { getDisplayPrefs, parseDisplayPrefs, setDisplayPrefs, subscribeDisplayPrefs } from "../web/src/lib/display.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("价格符号：只加前缀，符号顺序不乱，不设符号时与从前逐字节一致", () => {
  try {
    setDisplayPrefs({ priceSymbol: "" });
    assert.equal(money(1234.56), "1,234.56");
    assert.equal(money(-5), "-5.00");
    assert.equal(signed(-5), "-5.00");
    assert.equal(signed(5), "+5.00");

    setDisplayPrefs({ priceSymbol: "¥" });
    assert.equal(money(1234.56), "¥1,234.56");
    assert.equal(money(0), "¥0.00");
    assert.equal(money(-5), "-¥5.00", "负数是「减号 + 符号 + 数字」，不是「符号 + 减号」");
    assert.equal(signed(5), "+¥5.00");
    assert.equal(signed(-5), "-¥5.00");
    // 百分比不是金额：不吃价格符号
    assert.equal(pct(0.1234), "12.34%");
  } finally {
    setDisplayPrefs({ priceSymbol: "" });
  }
});

test("偏好解析：坏值逐字段回退默认，符号长度与类型都有闸", () => {
  assert.deepEqual(parseDisplayPrefs(null), { upDown: "green-up", priceSymbol: "" });
  assert.deepEqual(parseDisplayPrefs("天知道"), { upDown: "green-up", priceSymbol: "" });
  assert.deepEqual(parseDisplayPrefs({ upDown: "rainbow", priceSymbol: 42 }), {
    upDown: "green-up",
    priceSymbol: "",
  });
  assert.equal(parseDisplayPrefs({ priceSymbol: "USDT超长" }).priceSymbol, "USDT");
  assert.equal(parseDisplayPrefs({ priceSymbol: "  ¥  " }).priceSymbol, "¥");
  assert.equal(parseDisplayPrefs({ upDown: "red-up" }).upDown, "red-up");
});

test("变更通知：订阅者每次 set 都收到，退订后不再收", () => {
  setDisplayPrefs({ upDown: "green-up", priceSymbol: "" });
  const seen: string[] = [];
  const off = subscribeDisplayPrefs(() => seen.push(`${getDisplayPrefs().upDown}:${getDisplayPrefs().priceSymbol}`));
  setDisplayPrefs({ upDown: "red-up" });
  setDisplayPrefs({ priceSymbol: "$" });
  off();
  setDisplayPrefs({ upDown: "green-up" });
  try {
    assert.deepEqual(seen, ["red-up:", "red-up:$"]);
  } finally {
    setDisplayPrefs({ upDown: "green-up", priceSymbol: "" });
  }
});

test("界面接线：行情方向色可对调，系统状态色不跟随", () => {
  const css = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8");
  // 行情方向类走 --up/--down（设置对调的就是这一对）
  assert.match(css, /\.up \{ color: var\(--up\); \}/);
  assert.match(css, /\.down \{ color: var\(--down\); \}/);
  // 系统状态类走到固定的 --green/--red：红涨绿跌不会把「通道正常」变红
  assert.match(css, /\.chip-ok \{ color: var\(--green\)/);
  assert.match(css, /\.badge-error \{ color: var\(--red\)/);
  assert.match(css, /\.log-lv-error \{ color: var\(--red\)/);
  // 红涨绿跌 = 对调同一组变量（选择器不锁 :root，设置页卡片靠它做真身演示）
  assert.match(css, /\[data-updown="red-up"\] \{[\s\S]{0,220}?--up: var\(--red\);/);
  // 行情底色也成对（买卖标签不会出现「绿字红底」）
  assert.match(css, /\.side-buy \{ background: var\(--up-bg\); color: var\(--up\); \}/);
  assert.match(css, /\.side-sell \{ background: var\(--down-bg\); color: var\(--down\); \}/);

  const page = readFileSync(join(ROOT, "web", "src", "pages", "SettingsPage.tsx"), "utf8");
  assert.match(page, /setDisplayPrefs\(\{ upDown:/, "设置页必须写真实的涨跌颜色偏好");
  assert.match(page, /setDisplayPrefs\(\{ priceSymbol:/, "设置页必须写真实的价格符号偏好");
  assert.match(page, /setTheme\(/, "设置页的主题开关必须写真实的主题状态");
  assert.match(page, /useDisplayPrefs\(\)/, "设置页必须订阅偏好，改完立刻重渲染");
});

test("偏好落地的存储键与 <html data-updown> 都能从接线代码核对", () => {
  const wire = readFileSync(join(ROOT, "web", "src", "lib", "useDisplayPrefs.ts"), "utf8");
  assert.match(wire, /"aaaai\.display"/);
  assert.match(wire, /dataset\.updown = getDisplayPrefs\(\)\.upDown/);
});
