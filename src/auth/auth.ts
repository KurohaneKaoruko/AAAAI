/**
 * 可选鉴权：默认关闭，开启后支持两种方式。
 *
 * - 口令登录：用户名/密码登录后签发 HMAC 签名的会话 Cookie（HttpOnly）
 * - API Token：请求头 Authorization: Bearer <token>，也支持 ?token= 供 SSE 使用
 *
 * 配置全部来自环境变量，配置文件里只记录是否开启与用户名：
 *   AAAAI_AUTH_USERNAME / AAAAI_AUTH_PASSWORD / AAAAI_AUTH_TOKEN
 *   AAAAI_AUTH_SESSION_HOURS
 */

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getLogger } from "../core/logger.js";
import { envKey } from "../env.js";

const log = getLogger("auth");

export const COOKIE_NAME = "aaaai_session";

export interface AuthConfig {
  /** 是否需要登录 */
  required: boolean;
  username: string;
  password: string;
  /** Bearer Token（可单独使用，无需用户名密码） */
  token: string;
  sessionTtlMs: number;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const username = env[envKey("AUTH_USERNAME")] ?? "";
  const password = env[envKey("AUTH_PASSWORD")] ?? "";
  const token = env[envKey("AUTH_TOKEN")] ?? "";
  const sessionHours = Number(env[envKey("AUTH_SESSION_HOURS")] ?? 12);
  return {
    required: Boolean(username && password) || Boolean(token),
    username,
    password,
    token,
    sessionTtlMs: (Number.isFinite(sessionHours) && sessionHours > 0 ? sessionHours : 12) * 3600_000,
  };
}

export interface SessionPayload {
  sub: string;
  exp: number;
  nonce: string;
}

export class AuthService {
  /** 会话签名密钥：进程内随机，重启后旧会话失效（可接受且更安全）。 */
  private readonly sessionSecret = randomBytes(32).toString("hex");

  constructor(private readonly config: AuthConfig) {}

  isRequired(): boolean {
    return this.config.required;
  }

  publicConfig(): { authRequired: boolean; username: string; sessionTtlHours: number } {
    return {
      authRequired: this.config.required,
      username: this.config.username,
      sessionTtlHours: Math.round(this.config.sessionTtlMs / 3600_000),
    };
  }

  /** 用户名口令登录；成功返回会话 Token。 */
  login(username: string, password: string): string | null {
    if (!this.config.username || !this.config.password) return null;
    if (!safeEqual(username, this.config.username) || !safeEqual(password, this.config.password)) {
      return null;
    }
    return this.issue(username);
  }

  issue(username: string): string {
    const payload: SessionPayload = {
      sub: username,
      exp: Date.now() + this.config.sessionTtlMs,
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

  /** Bearer Token 校验（常量时间比较）。 */
  verifyToken(token: string | undefined): boolean {
    if (!this.config.token || !token) return false;
    return safeEqual(token, this.config.token);
  }

  /** 从请求中提取并校验身份：Cookie 会话或 Bearer Token。 */
  authenticate(req: Request): boolean {
    if (!this.config.required) return true;
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      if (this.verifyToken(header.slice(7))) return true;
    }
    // EventSource 无法自定义请求头，支持 query token
    const q = req.query.token;
    if (typeof q === "string" && this.verifyToken(q)) return true;
    const cookies = parseCookies(req.headers.cookie);
    return this.verifySession(cookies[COOKIE_NAME]) !== null;
  }

  setSessionCookie(res: Response, token: string): void {
    const maxAge = Math.floor(this.config.sessionTtlMs / 1000);
    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
    );
  }

  clearSessionCookie(res: Response): void {
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  /** Express 中间件：保护 /api 与页面资源。 */
  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (!this.config.required) return next();
      // 登录接口与状态查询必须放行
      if (req.path === "/api/auth/login" || req.path === "/api/auth/logout" || req.path === "/api/auth/status") {
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
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}