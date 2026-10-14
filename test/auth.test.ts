import assert from "node:assert/strict";
import test from "node:test";
import { AuthService, loadAuthConfig, type SessionPayload } from "../src/auth/auth.js";

function req(headers: Record<string, string | undefined> = {}, query: Record<string, string> = {}) {
  return { headers, query } as never;
}

test("loadAuthConfig: 默认关闭", () => {
  const c = loadAuthConfig({} as NodeJS.ProcessEnv);
  assert.equal(c.required, false);
  assert.equal(c.username, "");
  assert.equal(c.sessionTtlMs, 12 * 3600_000);
});

test("loadAuthConfig: 用户名+口令 或 Token 任一存在即启用", () => {
  const withUser = loadAuthConfig({ AAAAI_AUTH_USERNAME: "admin", AAAAI_AUTH_PASSWORD: "pw" } as NodeJS.ProcessEnv);
  assert.equal(withUser.required, true);

  const withToken = loadAuthConfig({ AAAAI_AUTH_TOKEN: "abc" } as NodeJS.ProcessEnv);
  assert.equal(withToken.required, true);
  assert.equal(withToken.username, "");

  // 只有用户名没有口令 -> 不启用（避免误锁死）
  const half = loadAuthConfig({ AAAAI_AUTH_USERNAME: "admin" } as NodeJS.ProcessEnv);
  assert.equal(half.required, false);

  const custom = loadAuthConfig({ AAAAI_AUTH_SESSION_HOURS: "3" } as NodeJS.ProcessEnv);
  assert.equal(custom.sessionTtlMs, 3 * 3600_000);
});

test("AuthService: 未启用时一切放行", () => {
  const auth = new AuthService(loadAuthConfig({} as NodeJS.ProcessEnv));
  assert.equal(auth.isRequired(), false);
  assert.equal(auth.authenticate(req()), true);
  assert.equal(auth.publicConfig().authRequired, false);
});

test("AuthService: 口令登录成功/失败", () => {
  const auth = new AuthService(
    loadAuthConfig({ AAAAI_AUTH_USERNAME: "admin", AAAAI_AUTH_PASSWORD: "s3cret" } as NodeJS.ProcessEnv),
  );
  assert.equal(auth.isRequired(), true);
  assert.equal(auth.login("admin", "wrong"), null);
  assert.equal(auth.login("other", "s3cret"), null);

  const token = auth.login("admin", "s3cret");
  assert.ok(token, "正确口令应签发会话");
  const payload = auth.verifySession(token);
  assert.ok(payload);
  assert.equal(payload!.sub, "admin");
  assert.ok(payload!.exp > Date.now());
});

test("AuthService: 会话令牌防伪改/过期", () => {
  const auth = new AuthService(
    loadAuthConfig({ AAAAI_AUTH_USERNAME: "admin", AAAAI_AUTH_PASSWORD: "pw" } as NodeJS.ProcessEnv),
  );
  const token = auth.login("admin", "pw")!;
  const [body, sig] = token.split(".");

  assert.equal(auth.verifySession(token)?.sub, "admin");
  assert.equal(auth.verifySession(`${body}.${sig}x`), null, "签名被改必须失效");
  assert.equal(auth.verifySession("garbage"), null);
  assert.equal(auth.verifySession(undefined), null);

  // 篡改 payload 但保留签名
  const forged = Buffer.from(JSON.stringify({ sub: "admin", exp: Date.now() + 9e9, nonce: "x" })).toString(
    "base64url",
  );
  assert.equal(auth.verifySession(`${forged}.${sig}`), null, "重放伪造 payload 必须失效");
});

test("AuthService: Bearer Token 认证", () => {
  const auth = new AuthService(loadAuthConfig({ AAAAI_AUTH_TOKEN: "tok-123" } as NodeJS.ProcessEnv));
  assert.equal(auth.authenticate(req({ authorization: "Bearer tok-123" })), true);
  assert.equal(auth.authenticate(req({ authorization: "Bearer nope" })), false);
  assert.equal(auth.authenticate(req({ authorization: "Basic xxx" })), false);
  assert.equal(auth.authenticate(req()), false);

  // EventSource 无法设置请求头，支持 query token
  assert.equal(auth.authenticate(req({}, { token: "tok-123" })), true);
});

test("AuthService: Cookie 会话认证", () => {
  const auth = new AuthService(
    loadAuthConfig({ AAAAI_AUTH_USERNAME: "admin", AAAAI_AUTH_PASSWORD: "pw" } as NodeJS.ProcessEnv),
  );
  const token = auth.login("admin", "pw")!;
  assert.equal(auth.authenticate(req({ cookie: `aaaai_session=${token}` })), true);
  assert.equal(auth.authenticate(req({ cookie: "aaaai_session=bogus" })), false);
  assert.equal(auth.authenticate(req()), false);
});

test("AuthService: 会话有效期可配置", () => {
  const auth = new AuthService(
    loadAuthConfig({ AAAAI_AUTH_TOKEN: "t", AAAAI_AUTH_SESSION_HOURS: "0.02" } as NodeJS.ProcessEnv),
  );
  const payload = auth.issue("admin") as unknown as string;
  const [body] = payload.split(".");
  const parsed = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as SessionPayload;
  const ttl = parsed.exp - Date.now();
  assert.ok(ttl > 0 && ttl <= 0.02 * 3600_000 + 1000, "有效期应约 72 秒");
});

test("AuthService: publicConfig 不泄露任何密钥", () => {
  const auth = new AuthService(
    loadAuthConfig({
      AAAAI_AUTH_USERNAME: "admin",
      AAAAI_AUTH_PASSWORD: "super-secret",
      AAAAI_AUTH_TOKEN: "token-secret",
    } as NodeJS.ProcessEnv),
  );
  const json = JSON.stringify(auth.publicConfig());
  assert.ok(!json.includes("super-secret"), "不得泄露口令");
  assert.ok(!json.includes("token-secret"), "不得泄露 Token");
  assert.equal(json.includes("admin"), true, "用户名可展示用于登录页预填");
});