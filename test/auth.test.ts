import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "../src/auth/auth.js";

function req(headers: Record<string, string | undefined> = {}) {
  return { headers } as never;
}

function newAuth(): { auth: AuthService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "aaaai-auth-"));
  return { auth: new AuthService(dir), dir };
}

test("AuthService: 默认无密码，一切放行，needsSetup", () => {
  const { auth, dir } = newAuth();
  assert.equal(auth.hasPassword(), false);
  assert.equal(auth.needsSetup(), true);
  assert.equal(auth.authenticate(req()), true, "没设密码 = 免登录直进");
  assert.equal(auth.login("任意"), null, "没设密码时登录不产出会话");
  assert.ok(!existsSync(join(dir, "auth.json")), "未设置前不落文件");
});

test("AuthService: 首次设置密码 → 需要登录；跳过设置 = 免登录", () => {
  const { auth } = newAuth();
  assert.equal(auth.setupPassword("hunter2"), true);
  assert.equal(auth.hasPassword(), true);
  assert.equal(auth.needsSetup(), false);

  // 已设密码后 setup 不可用（防止覆盖）
  assert.equal(auth.setupPassword("hacked"), false);

  // 正确密码登录，错误密码拒绝
  assert.equal(auth.login("wrong"), null);
  const token = auth.login("hunter2");
  assert.ok(token, "正确密码应签发会话");
  const payload = auth.verifySession(token);
  assert.ok(payload);
  assert.ok(payload!.exp > Date.now());

  // Bearer 就是同一个密码，没有第二把钥匙
  assert.equal(auth.authenticate(req({ authorization: "Bearer hunter2" })), true);
  assert.equal(auth.authenticate(req({ authorization: "Bearer wrong" })), false);
});

test("AuthService: 密码散列落盘（scrypt 加盐，不存明文），重启后仍有效", () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaai-auth-"));
  const first = new AuthService(dir);
  first.setupPassword("hunter2");

  const raw = readFileSync(join(dir, "auth.json"), "utf8");
  assert.ok(!raw.includes("hunter2"), "文件里绝不能有明文密码");
  const parsed = JSON.parse(raw) as { passwordHash: string; salt: string };
  assert.ok(parsed.passwordHash.length > 0);
  assert.ok(parsed.salt.length > 0);

  // 模拟重启：新实例从文件恢复
  const second = new AuthService(dir);
  assert.equal(second.hasPassword(), true);
  assert.equal(second.login("hunter2") !== null, true);
  rmSync(dir, { recursive: true, force: true });
});

test("AuthService: 改密码/删密码必须验证旧密码", () => {
  const { auth } = newAuth();
  auth.setupPassword("old-pass");

  assert.equal(auth.changePassword("wrong", "new-pass"), false, "旧密码错，拒绝改");
  assert.equal(auth.changePassword("old-pass", "new-pass"), true);
  assert.equal(auth.login("old-pass"), null, "旧密码应失效");
  assert.ok(auth.login("new-pass"), "新密码应能登录");

  assert.equal(auth.removePassword("wrong"), false, "旧密码错，拒绝删");
  assert.equal(auth.removePassword("new-pass"), true);
  assert.equal(auth.hasPassword(), false);
  assert.equal(auth.authenticate(req()), true, "删密码后回到免登录");
  assert.equal(auth.needsSetup(), true, "删密码后回到首启状态");
});

test("AuthService: 会话令牌防伪改/过期", () => {
  const { auth } = newAuth();
  auth.setupPassword("pw");
  const token = auth.login("pw");
  assert.ok(token);

  const [body, sig] = token!.split(".");
  assert.equal(auth.verifySession(`${body}.forged`), null, "签名改一个字都过不了");
  const evil = Buffer.from(JSON.stringify({ exp: Date.now() + 999_999_999 })).toString("base64url");
  assert.equal(auth.verifySession(`${evil}.${sig}`), null, "换 body 也不行（签名对不上）");

  const expired = auth.verifySession(
    Buffer.from(JSON.stringify({ exp: Date.now() - 1000 })).toString("base64url") + "." + sig,
  );
  assert.equal(expired, null, "过期的会话无效");
});

test("AuthService: 中间件拦截/放行边界", () => {
  const { auth } = newAuth();
  auth.setupPassword("pw");
  const mw = auth.middleware();

  const next = () => {
    called = true;
  };
  let called = false;
  const res = { status: () => ({ json: () => {} }) } as never;

  // 免鉴权路径
  for (const path of ["/api/auth/status", "/api/auth/login", "/api/auth/setup", "/api/health"]) {
    called = false;
    mw({ path, headers: {} } as never, res, next);
    assert.equal(called, true, `${path} 必须放行（否则进不去/探活失败）`);
  }

  // 未认证 API 被拦
  called = false;
  let status = 0;
  const res401 = {
    status: (code: number) => ({
      json: () => {
        status = code;
      },
    }),
  } as never;
  mw({ path: "/api/bots", headers: {} } as never, res401, next);
  assert.equal(called, false, "未认证 API 必须被拦");
  assert.equal(status, 401);

  // Bearer 带对密码放行
  called = false;
  mw({ path: "/api/bots", headers: { authorization: "Bearer pw" } } as never, res, next);
  assert.equal(called, true, "Bearer + 密码应放行");
});
