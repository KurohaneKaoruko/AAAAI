/**
 * 首启页：服务端没设过密码 → 引导设置密码（可跳过 = 不设密码，面板免登录）；
 * 已设密码 → 登录。一个页面两种形态，状态来自 /api/auth/status。
 */

import { useState } from "react";
import { api } from "../api";

export function LoginPage({
  needsSetup,
  onSuccess,
}: {
  needsSetup: boolean;
  onSuccess: () => void;
}) {
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (needsSetup) {
        if (password.length < 4) throw new Error("密码至少 4 位");
        if (password !== password2) throw new Error("两次输入的密码不一致");
        await api.setupPassword(password);
      } else {
        await api.login(password);
      }
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const skip = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.setupPassword("");
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
        {needsSetup ? (
          <>
            <p className="login-hint">设置面板密码（也可以跳过，不设密码）</p>
            <label className="field">
              <span className="field-label">密码</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                autoFocus
              />
            </label>
            <label className="field">
              <span className="field-label">再输一次</span>
              <input
                type="password"
                value={password2}
                onChange={(e) => setPassword2(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            {error && <div className="login-error">{error}</div>}
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "设置中…" : "设置密码并进入"}
            </button>
            <button type="button" className="btn btn-ghost login-skip" disabled={busy} onClick={() => void skip()}>
              跳过，不设密码
            </button>
            <p className="small dim login-note">
              跳过后面板无需登录直接使用；之后随时可以在「设置」页里补设密码。
            </p>
          </>
        ) : (
          <>
            <p className="login-hint">请输入密码继续</p>
            <label className="field">
              <span className="field-label">密码</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                autoFocus
              />
            </label>
            {error && <div className="login-error">{error}</div>}
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "登录中…" : "登录"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
