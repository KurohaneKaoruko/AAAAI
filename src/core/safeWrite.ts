/**
 * 数据文件原子写：先写同目录临时文件，fsync 后 rename 覆盖。
 *
 * 为什么不用 `writeFileSync(path, ...)`：它先以 `w` 打开并截断原文件，
 * 再写入内容。磁盘写满（ENOSPC）或进程中途崩溃时，旧文件已经被截断，
 * 结果就是 0 字节的 JSON —— 2026-11-06 的 Docker 磁盘满事故里，
 * strategies.json / bots-history.json 就是这么丢的。
 *
 * rename 在同一文件系统内是原子操作：临时文件写成功之前，目标文件
 * 保持原样；写失败只会留下一个 .tmp-* 临时文件（下面会清理），
 * 不会破坏上一份可用数据。
 */

import { closeSync, fchmodSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";

export interface AtomicWriteOptions {
  /** 新文件权限，默认 0600（数据目录里多为密钥/持仓，默认收紧）。 */
  mode?: number;
}

export function writeFileAtomic(path: string, data: string, options: AtomicWriteOptions = {}): void {
  const mode = options.mode ?? 0o600;
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "w", mode);
    writeSync(fd, data, null, "utf8");
    // mode 会先被 umask 影响，fchmod 保证最终权限精确（尤其是 0600）
    fchmodSync(fd, mode);
    // 先落盘再 rename：避免「rename 成功但内容还在页缓存」下掉电得到空文件
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败不掩盖原始错误
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件可能根本没创建成功
    }
    throw err;
  }
}
