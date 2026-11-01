/** 登录页：仅在服务端启用鉴权且未认证时出现。 */

import { useState } from "react";
import { api } from "../api";

export function LoginPage({
  username: defaultUsername,
  onSuccess,
}: {
  username: string;
  onSuccess: () => void;
}) {
  const [username, setUsername] = useState(defaultUsername);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username, password);
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 只配了 AAAAI_AUTH_TOKEN（无用户名口令）时：Token 存本地，后续请求带 Bearer。 */
  const submitToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const token = password.trim();
    if (!token) {
      setError("请粘贴 Token");
      setBusy(false);
      return;
    }
    try {
      // 用这个 Token 打一次鉴权接口验证，通过才保存
      const res = await fetch(`${import.meta.env.DEV ? "http://localhost:8787" : ""}/api/auth/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Token 无效");
      const data = (await res.json()) as { authenticated: boolean };
      if (!data.authenticated) throw new Error("Token 无效");
      window.localStorage.setItem("aaaai.token", token);
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="logo">AAAAI</span>
          <span className="brand-sub">Ai-Agent-Auto-Asset-Investment</span>
        </div>
        <p className="login-hint">请登录后继续</p>
        <label className="field">
          <span className="field-label">用户名</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </label>
        <label className="field">
          <span className="field-label">口令</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "登录中…" : "登录"}
        </button>
        {defaultUsername === "" && (
          <>
            <button type="button" className="btn" disabled={busy} onClick={(e) => void submitToken(e)}>
              用 Token 登录
            </button>
            <p className="login-hint">只配置了 AAAAI_AUTH_TOKEN 时，把 Token 粘进「口令」框后点这里。</p>
          </>
        )}
      </form>
    </div>
  );
}