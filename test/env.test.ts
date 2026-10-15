/**
 * 环境变量命名空间的防回归测试。
 *
 * 项目名 AAAAI = Ai / Agent / Auto / Asset / Investment 的首字母，
 * 即「4 个 A + 1 个 I」。历史上曾多次出现手写错 A 的个数
 * （3 个 / 5 个）导致环境变量读不到，因此把规则固化成测试。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_PREFIX, envKey } from "../src/env.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("ENV_PREFIX 恰好是 4 个 A + 1 个 I", () => {
  assert.equal(ENV_PREFIX, "AAAAI");
  const aCount = ENV_PREFIX.length - ENV_PREFIX.replace(/^A+/, "").length;
  assert.equal(aCount, 4, "A 的个数必须是 4（Ai / Agent / Auto / Asset）");
  assert.equal(ENV_PREFIX.at(-1), "I", "最后一位必须是 I（Investment）");
});

test("envKey 拼接结果正确", () => {
  assert.equal(envKey("AUTH_USERNAME"), "AAAAI_AUTH_USERNAME");
  assert.equal(envKey("CONFIG"), "AAAAI_CONFIG");
  assert.equal(envKey("DATA_DIR"), "AAAAI_DATA_DIR");
});

/** 递归收集需要检查的文本文件。 */
function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if ([".git", "node_modules", "dist", "data", "coverage"].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.(ts|tsx|yaml|yml|json|md|example|env)$|^\.env/.test(entry) || entry === ".env.example") {
      out.push(full);
    }
  }
  return out;
}

test("仓库内不存在手写错 A 个数的环境变量前缀", () => {
  // 匹配形如 A{n}I_xxx 或 A{n}_AUTH_xxx 的疑似手写前缀
  const pattern = /\bA{2,}I_[A-Z_]+|\bA{2,}_(?:AUTH_[A-Z_]+|CONFIG|DATA_DIR|AUTOSTART|PORT)\b/g;
  const offenders: string[] = [];

  for (const file of collect(ROOT)) {
    // src/env.ts 是唯一定义前缀的地方，允许出现
    if (file.endsWith(join("src", "env.ts"))) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const token = match[0];
      const aCount = token.length - token.replace(/^A+/, "").length;
      if (aCount !== 4) offenders.push(`${file.replace(ROOT + "/", "")}: ${token} (${aCount} 个A)`);
    }
  }

  assert.deepEqual(offenders, [], "以下位置的环境变量前缀 A 的个数不正确（应为 4 个）");
});

test("src 中除 env.ts 外不再手写环境变量名", () => {
  const pattern = /["'`]A{2,}I_[A-Z_]+["'`]/g;
  const offenders: string[] = [];
  for (const file of collect(join(ROOT, "src"))) {
    if (file.endsWith(join("src", "env.ts"))) continue;
    for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
      offenders.push(`${file.replace(ROOT + "/", "")}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], "应统一通过 envKey()/readEnv() 构造环境变量名");
});
test("仓库内任何位置都不出现 3 个或 5 个及以上的 A 连写（含散文与注释）", () => {
  // 上一条测试只认「A{n}I_XXX」「A{n}_AUTH_XXX」这类带下划线的标识符，
  // 于是「5 个 A + 空格 + 中文散文」（无下划线）和 src/env.ts 的注释示例都漏网了 —— 两个真实笔误都出在这两种形态上。
  // 这里改成：不认形态，只认「连续 3 个以上 A」这件事本身。
  const offenders: string[] = [];
  for (const file of collect(ROOT)) {
    const rel = file.replace(ROOT + "/", "");
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/A{3,}/g)) {
      if (match[0].length !== 4) offenders.push(`${rel}: ${match[0]} (${match[0].length} 个A)`);
    }
  }
  assert.deepEqual(offenders, [], "A 的连写只能是 4 个（AAAAI = Ai/Agent/Auto/Asset + Investment）");
});

test("README 与 env.ts 里的示例变量名与 envKey() 实际产物一致", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const envSrc = readFileSync(join(ROOT, "src", "env.ts"), "utf8");

  // 文档里出现的每个 AAAA… 标记，都必须正好等于 ENV_PREFIX
  // 注意：字符串要按数组元素拼，别用 [...str]（那是把字符摊开）
  const tokens = [readme, envSrc].join("\n").match(/\bA{4,}\w*/g) ?? [];
  for (const token of new Set(tokens)) {
    const head = token.match(/^A*I/)?.[0] ?? token.match(/^A+/)?.[0] ?? token;
    assert.equal(head, ENV_PREFIX, `文档里的「${token}」应以 ${ENV_PREFIX} 开头`);
  }
  assert.ok(tokens.length > 0, "文档里应当存在该标记，否则这条测试没起到作用");
});
