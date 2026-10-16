/**
 * 模拟对照的「两处同源」检查。
 *
 * 服务端与前端分开打包，有的常量只能各写一份 —— 参赛者上限就是。
 * 写歪了的表现是「界面让人勾得上，一点就被服务端拒」，所以钉住它们相等。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_RUNNERS } from "../src/bench/participants.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("对照：前端写死的参赛者上限必须与服务端一致", () => {
  const page = readFileSync(join(ROOT, "web", "src", "pages", "ComparePage.tsx"), "utf8");
  const m = page.match(/const MAX_RUNNERS = (\d+);/);
  assert.ok(m, "ComparePage 应当写死一个 MAX_RUNNERS（勾选时的第一道拦）");
  assert.equal(
    Number(m[1]),
    MAX_RUNNERS,
    `前端上限 ${m[1]} 与服务端 ${MAX_RUNNERS} 不一致：界面会让人勾到服务端不接受的数量`,
  );
});
