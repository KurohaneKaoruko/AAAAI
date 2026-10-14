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
      </form>
    </div>
  );
}