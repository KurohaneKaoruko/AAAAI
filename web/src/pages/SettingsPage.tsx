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
import { setDisplayPrefs, UP_DOWN_LABEL, type UpDownMode } from "../lib/display";
import { money } from "../lib/format";
import { useTheme, type Theme } from "../lib/theme";
import { useDisplayPrefs } from "../lib/useDisplayPrefs";

const MODES: { value: UpDownMode; desc: string }[] = [
  { value: "red-up", desc: "中国大陆行情软件习惯：上涨、盈利、买入用红，下跌、亏损、卖出用绿。" },
  { value: "green-up", desc: "国际 / 加密行情软件习惯：上涨、盈利、买入用绿，下跌、亏损、卖出用红。" },
];

const THEME_OPTIONS: { value: Theme; label: string; desc: string }[] = [
  { value: "dark", label: "暗色", desc: "纯黑基调（默认）" },
  { value: "light", label: "亮色", desc: "纯白基调" },
];

const SYMBOL_PRESETS = ["", "¥", "$", "USDT"];

export function SettingsPage() {
  const display = useDisplayPrefs();
  const { theme, setTheme } = useTheme();

  return (
    <>
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
          <b className="mono">localStorage["aaaai.theme"]</b>。 换浏览器、换设备或清除站点数据后回到默认：绿涨红跌、
          无价格符号、暗色。
        </p>
      </Panel>
    </>
  );
}
