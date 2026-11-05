/**
 * 设置页：显示偏好（涨跌颜色 / 价格符号 / 主题）。
 *
 * 只保存在这台浏览器（localStorage），不上传服务端 —— 这几项只改「怎么看」，
 * 不改任何交易行为。「存在哪里」面板把存储键写清楚，方便从代码核对。
 *
 * 涨跌颜色的选项卡片自己挂着 data-updown：卡片里的 +1.23% / -0.45% 走的就是
 * 全站那套行情色变量（styles.css 的 [data-updown="red-up"] 覆盖块），
 * 是「真身演示」而不是另画一份示意。
 */

import { Button, Panel } from "../components/ui";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { api } from "../api";
import { setDisplayPrefs, UP_DOWN_LABEL, type UpDownMode } from "../lib/display";
import { money } from "../lib/format";
import { useTheme, type Theme } from "../lib/theme";
import { useDisplayPrefs } from "../lib/useDisplayPrefs";
import { useCallback, useEffect, useState } from "react";

const MODES: { value: UpDownMode; desc: string }[] = [
  { value: "red-up", desc: "中国大陆行情软件习惯：上涨、盈利、买入用红，下跌、亏损、卖出用绿。" },
  { value: "green-up", desc: "国际 / 加密行情软件习惯：上涨、盈利、买入用绿，下跌、亏损、卖出用红。" },
];

/** 面板密码管理：设了密码要登录；没设免登录。改/删都要验旧密码。 */
function PasswordPanel() {
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [newPwd2, setNewPwd2] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api.authStatus();
      setHasPassword(s.hasPassword);
    } catch {
      // 查不到状态时按「已有密码」处理，避免误显示设置表单把密码覆盖掉
      setHasPassword(true);
    }
  }, []);

  // 以前在 render 里直接 void refresh()：每次重渲染都会再打一次请求。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    setConfirmDelete(false);
    try {
      const text = await fn();
      setMsg({ ok: true, text });
      setOldPwd("");
      setNewPwd("");
      setNewPwd2("");
      await refresh();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (hasPassword === null) return null;

  return (
    <Panel
      title="面板密码"
      subtitle={
        hasPassword
          ? "已设置：打开面板需要输入密码。脚本用同一个密码走 Authorization: Bearer <密码>。"
          : "未设置：面板免登录直接使用。局域网内任何人都能打开，介意就设一个。"
      }
    >
      <form
        className="set-symbol"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          if (hasPassword) {
            void run(async () => {
              if (newPwd.length < 4) throw new Error("新密码至少 4 位");
              if (newPwd !== newPwd2) throw new Error("两次输入的新密码不一致");
              await api.changePassword(oldPwd, newPwd);
              return "密码已修改";
            });
          } else {
            void run(async () => {
              if (newPwd.length < 4) throw new Error("密码至少 4 位");
              if (newPwd !== newPwd2) throw new Error("两次输入的密码不一致");
              await api.setupPassword(newPwd);
              return "密码已设置，下次打开面板需要登录";
            });
          }
        }}
      >
        {hasPassword && (
          <input
            type="password"
            value={oldPwd}
            placeholder="旧密码"
            aria-label="旧密码"
            autoComplete="current-password"
            onChange={(e) => setOldPwd(e.target.value)}
          />
        )}
        <input
          type="password"
          value={newPwd}
          placeholder="新密码（至少 4 位）"
          aria-label="新密码"
          autoComplete="new-password"
          onChange={(e) => setNewPwd(e.target.value)}
        />
        <input
          type="password"
          value={newPwd2}
          placeholder="再输一次新密码"
          aria-label="再输一次新密码"
          autoComplete="new-password"
          onChange={(e) => setNewPwd2(e.target.value)}
        />
        <Button
          small
          type="submit"
          busy={busy}
          disabled={!newPwd || (hasPassword && !oldPwd)}
        >
          {hasPassword ? "修改密码" : "设置密码"}
        </Button>
        {hasPassword && !confirmDelete && (
          <Button
            small
            variant="danger"
            disabled={busy || !oldPwd}
            onClick={() => setConfirmDelete(true)}
          >
            删除密码
          </Button>
        )}
      </form>
      <ConfirmDialog
        open={hasPassword && confirmDelete}
        title="删除面板密码？"
        message="删除后本面板会回到免登录状态，同一局域网内任何人都能直接打开。需要重新设置密码时，可随时在这里再设。"
        confirmText="删除密码"
        busy={busy}
        onConfirm={() =>
          void run(async () => {
            await api.removePassword(oldPwd);
            return "密码已删除，面板回到免登录";
          })
        }
        onCancel={() => setConfirmDelete(false)}
      />
      {msg && (
        <p className="small" style={{ color: msg.ok ? "var(--up, #16a34a)" : "var(--down, #dc2626)" }}>
          {msg.text}
        </p>
      )}
      <p className="small dim set-note">
        密码散列存在服务端 data/auth.json（0600），不在配置文件、不在环境变量。
        忘了密码：删除该文件并重启容器，回到「首次设置」。
      </p>
    </Panel>
  );
}

const THEME_OPTIONS: { value: Theme; label: string; desc: string }[] = [
  { value: "light", label: "亮色", desc: "纯白基调（默认）" },
  { value: "dark", label: "暗色", desc: "纯黑基调" },
];

const SYMBOL_PRESETS = ["", "¥", "$", "USDT"];

export function SettingsPage() {
  const display = useDisplayPrefs();
  const { theme, setTheme } = useTheme();

  return (
    <>
      <PasswordPanel />
      <Panel title="涨跌颜色" subtitle="只改行情方向色；运行 / 报错这类系统状态色固定为绿=正常、红=危险">
        <div className="decision-options" role="radiogroup" aria-label="涨跌颜色">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={display.upDown === m.value}
              data-updown={m.value}
              className={`decision-option ${display.upDown === m.value ? "decision-on" : ""}`}
              onClick={() => setDisplayPrefs({ upDown: m.value })}
            >
              <span className="decision-label">
                {UP_DOWN_LABEL[m.value]}
                <span className="up">+1.23%</span>
                <span className="down">-0.45%</span>
              </span>
              <span className="decision-desc">{m.desc}</span>
            </button>
          ))}
        </div>
        <p className="small dim set-note">
          跟随的颜色：涨跌幅、盈亏、权益曲线、买卖方向、新闻情绪。不跟随的颜色：机器人「运行中」、通道「正常」、
          报错 —— 它们永远是绿=正常、红=危险，免得把状态读反。
        </p>
      </Panel>

      <Panel title="价格符号" subtitle="给金额加显示前缀；只影响显示，不做汇率换算">
        <div className="set-symbol">
          <input
            value={display.priceSymbol}
            maxLength={4}
            placeholder="不显示"
            aria-label="价格符号"
            onChange={(e) => setDisplayPrefs({ priceSymbol: e.target.value })}
          />
          {SYMBOL_PRESETS.map((p) => (
            <Button key={p || "none"} small onClick={() => setDisplayPrefs({ priceSymbol: p })}>
              {p || "无"}
            </Button>
          ))}
          <span className="small dim">
            预览：<b className="mono">{money(1234567.89)}</b>
          </span>
        </div>
        <p className="small dim set-note">
          最多 4 个字符，留空 = 不显示。金额一律「符号 + 数字」，负数写作 -¥5.00。
          符号只是显示前缀：不会把不同连接的金额换算成同一币种。
        </p>
      </Panel>

      <Panel title="主题" subtitle="与右上角快捷开关是同一个设置">
        <div className="decision-options" role="radiogroup" aria-label="主题">
          {THEME_OPTIONS.map((t) => (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={theme === t.value}
              className={`decision-option ${theme === t.value ? "decision-on" : ""}`}
              onClick={() => setTheme(t.value)}
            >
              <span className="decision-label">{t.label}</span>
              <span className="decision-desc">{t.desc}</span>
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="存在哪里" subtitle="只在这台浏览器生效，不上传服务端">
        <p className="small dim set-note">
          涨跌颜色与价格符号存在 <b className="mono">localStorage["aaaai.display"]</b>，主题存在{" "}
          <b className="mono">localStorage["aaaai.theme"]</b>。 换浏览器、换设备或清除站点数据后回到默认：红涨绿跌、
          无价格符号、亮色。
        </p>
      </Panel>
    </>
  );
}
