/**
 * 原子写：盘满/崩溃时不能把上一份可用的 JSON 截成 0 字节。
 *
 * 复现背景：2026-11-06 Docker 宿主机磁盘满，`writeFileSync` 先把
 * strategies.json 截断再写失败，留下 0 字节文件，服务启动即退出。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/core/safeWrite.js";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "aaaai-safe-write-"));
}

test("原子写：正常写入、权限 0600、不留下临时文件", () => {
  const d = dir();
  try {
    const path = join(d, "strategies.json");
    writeFileAtomic(path, JSON.stringify({ hello: "世界" }));
    assert.equal(readFileSync(path, "utf8"), '{"hello":"世界"}');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(d), ["strategies.json"], "不应留下 .tmp-* 文件");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("原子写：覆盖已有文件成功", () => {
  const d = dir();
  try {
    const path = join(d, "watchlist.json");
    writeFileSync(path, "old", { mode: 0o600 });
    writeFileAtomic(path, "new");
    assert.equal(readFileSync(path, "utf8"), "new");
    assert.deepEqual(readdirSync(d), ["watchlist.json"]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("原子写：写入失败时目标保持原样，临时文件被清理", () => {
  const d = dir();
  try {
    // 目标是目录：临时文件能写成功，但 rename 覆盖目录会失败
    const path = join(d, "strategies.json");
    mkdirSync(path);
    assert.throws(() => writeFileAtomic(path, "{}"));
    assert.ok(statSync(path).isDirectory(), "失败不应破坏原目标");
    assert.deepEqual(readdirSync(d), ["strategies.json"], "失败后临时文件必须清理");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("原子写：父目录不存在时报错且不产生残留", () => {
  const d = dir();
  try {
    const path = join(d, "no-such-dir", "a.json");
    assert.throws(() => writeFileAtomic(path, "{}"));
    assert.deepEqual(readdirSync(d), []);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
