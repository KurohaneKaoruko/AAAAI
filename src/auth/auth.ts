/**
 * 可选鉴权：**只有一个密码，没有用户名。**
 *
 * 设计（最朴素的一条线）：
 * - 密码哈希存在 `data/auth.json`（0600），不进配置文件、不进环境变量；
 * - 第一次启动时 `auth.json` 不存在 → 服务端报告 needsSetup，
 *   前端显示「设置密码」页；**直接跳过 = 不设密码，面板裸奔**；
 * - 已设密码：浏览器登录拿 HMAC 会话 Cookie；脚本 `Authorization: Bearer <密码>`；
 * - 想改密码 / 删密码：面板「设置」页里操作，不需要碰文件和终端。
 *
 * 历史：曾经有过环境变量口令、更早还有独立的 API Token，结果是
 * 「面板一个密码、脚本另一个密码、重启后哪个是哪个谁也说不清」。
 * 全部废除 —— 事实来源只有 data/auth.json 这一个文件。
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { writeFileAtomic } from "../core/safeWrite.js";
import { join } from "node:path";
import type { NextFunction, Request, Response } from "express";
import { getLogger } from "../core/logger.js";

const log = getLogger("auth");

export const COOKIE_NAME = "aaaai_session";

/** auth.json 的结构：只存散列和盐，从不存明文。 */
interface AuthFile {
  /** scrypt 散列（hex） */
  passwordHash: string;
  /** 随机盐（hex） */
  salt: string;
  /** 设置时间（ISO） */
  createdAt: string;
}

/** 会话有效期：固定 7 天。不做配置项 —— 又少一个要理解的概念。 */
const SESSION_TTL_MS = 7 * 24 * 3600_000;

export class AuthService {
  /** 会话签名密钥：进程内随机，重启后旧会话失效（可接受且更安全）。 */
  private readonly sessionSecret = randomBytes(32).toString("hex");
  private readonly path: string;
  private file: AuthFile | null = null;

  constructor(dataDir: string) {
    this.path = join(dataDir, "auth.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as AuthFile;
      if (raw.passwordHash && raw.salt) this.file = raw;
    } catch (err) {
      log.warn("auth.json 解析失败，按未设密码处理: %s", (err as Error).message);
    }
  }

  private persist(file: AuthFile | null): void {
    if (file === null) {
      if (existsSync(this.path)) rmSync(this.path);
      this.file = null;
      return;
    }
    mkdirSync(this.path.slice(0, this.path.lastIndexOf("/")), { recursive: true });
    writeFileAtomic(this.path, JSON.stringify(file, null, 2), { mode: 0o600 });
    chmodSync(this.path, 0o600);
    this.file = file;
  }

  /** 是否已设置密码（没设 = 面板免登录）。 */
  hasPassword(): boolean {
    return this.file !== null;
  }

  /** 首次设置密码；已有密码时不可用（改密码走 changePassword）。 */
  setupPassword(password: string): boolean {
    if (this.file) return false;
    this.persist(hashPassword(password));
    log.info("已设置面板密码");
    return true;
  }

  /** 修改密码：必须验证旧密码。 */
  changePassword(oldPassword: string, newPassword: string): boolean {
    if (!this.file || !this.verify(oldPassword)) return false;
    this.persist(hashPassword(newPassword));
    log.info("面板密码已修改");
    return true;
  }

  /** 删除密码：验证旧密码后回到「无密码」状态。 */
  removePassword(oldPassword: string): boolean {
    if (!this.file || !this.verify(oldPassword)) return false;
    this.persist(null);
    log.info("面板密码已删除（免登录）");
    return true;
  }

  /** 校验密码（常量时间比较）。 */
  verify(password: string): boolean {
    if (!this.file) return false;
    const expected = Buffer.from(this.file.passwordHash, "hex");
    const actual = scryptSync(password, this.file.salt, expected.length);
    return timingSafeEqual(expected, actual);
  }

  /** 首次进入：需要设置密码吗（没设过密码且不是跳过状态）。 */
  needsSetup(): boolean {
    return this.file === null;
  }

  login(password: string): string | null {
    if (!this.file || !this.verify(password)) return null;
    return this.issue();
  }

  private issue(): string {
    const payload: SessionPayload = {
      exp: Date.now() + SESSION_TTL_MS,
      nonce: randomBytes(6).toString("hex"),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${this.sign(body)}`;
  }

  private sign(body: string): string {
    return createHmac("sha256", this.sessionSecret).update(body).digest("base64url");
  }

  /** 校验会话 Token。 */
  verifySession(token: string | undefined): SessionPayload | null {
    if (!token) return null;
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = this.sign(body);
    if (!safeEqual(sig, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
      if (!payload.exp || payload.exp < Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  /** Bearer 里的密码校验：脚本用的就是面板密码，不是第二把钥匙。 */
  private verifyBearer(secret: string | undefined): boolean {
    return this.file !== null && !!secret && this.verify(secret);
  }

  authenticate(req: Request): boolean {
    if (!this.file) return true; // 没设密码 = 全放行
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ") && this.verifyBearer(header.slice(7))) return true;
    const cookies = parseCookies(req.headers.cookie);
    return this.verifySession(cookies[COOKIE_NAME]) !== null;
  }

  setSessionCookie(res: Response, token: string): void {
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
    );
  }

  clearSessionCookie(res: Response): void {
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  /** Express 中间件：保护 /api。 */
  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      // 没设密码：一切放行（包括 setup 接口之外的全部 API —— 跳过设置就是裸奔，说到做到）
      if (!this.file) return next();
      // 已设密码：这几个接口必须免鉴权，否则永远进不去
      if (
        req.path === "/api/auth/status" ||
        req.path === "/api/auth/login" ||
        req.path === "/api/auth/setup" ||
        req.path === "/api/health"
      ) {
        return next();
      }
      if (this.authenticate(req)) return next();
      log.debug("未认证请求被拦截: %s %s", req.method, req.path);
      if (req.path.startsWith("/api/")) {
        res.status(401).json({ error: "未认证", authRequired: true });
      } else {
        // 页面请求放行到前端，由前端展示登录界面
        next();
      }
    };
  }
}

export interface SessionPayload {
  exp: number;
  nonce: string;
}

/** scrypt 加盐散列。scrypt 是内存困难型 KDF，专为低熵口令设计。 */
function hashPassword(password: string): AuthFile {
  const salt = randomBytes(16).toString("hex");
  return {
    passwordHash: scryptSync(password, salt, 32).toString("hex"),
    salt,
    createdAt: new Date().toISOString(),
  };
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    out[part.slice(0, idx).trim()!] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
