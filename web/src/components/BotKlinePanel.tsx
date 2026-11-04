/**
 * 机器人 K 线面板：按机器人所属连接/标的拉取实时 K 线，叠加它的成交标记与均线。
 *
 * 刷新节奏（刻意的）：
 * - 不走「每次 SSE 状态广播就重拉」：机器人每几秒广播一次全量 state，
 *   K 线历史根本没变，重拉只是浪费；
 * - 15s 定时轮询保证当前未收盘 K 线保持新鲜；SSE 只触发一次节流刷新
 *   （30s 内至多一次），覆盖「刚启动/刚有成交，想马上看到」的场景。
 *
 * 数据源：/api/klines（独立请求，不影响机器人自己的行情轮询）。
 * 真实交易所的公开行情固定走主网，测试网只影响下单/账户 —— 图上的价格
 * 必须是真实市场，不能拿测试网行情冒充实盘。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Button, Empty, Panel } from "./ui";
import { Select } from "./Select";
import { KlineChart, type TradeMarker } from "./KlineChart";
import type { Bot, KlineBar } from "../types";
import { time } from "../lib/format";

/** 定时轮询周期：真实行情下让当前未收盘 K 线保持新鲜 */
const POLL_MS = 15_000;
/** SSE 触发刷新的节流窗口 */
const SSE_THROTTLE_MS = 30_000;
/** 可选周期：与主流适配器的 klineIntervals 取交集（Stooq 只支持 1d，切换时后端会报错并显示） */
const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
type Interval = (typeof INTERVALS)[number];

export function BotKlinePanel({ bot }: { bot: Bot }) {
  const [symbol, setSymbol] = useState(bot.symbols[0] ?? "");
  const [interval, setInterval_] = useState<Interval>(normalizeInterval(bot.interval));
  const [bars, setBars] = useState<KlineBar[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  /** 上一次 SSE 触发的刷新时刻（节流用） */
  const lastSseFetch = useRef(0);

  // 标的切换/机器人变化时重置选择
  useEffect(() => {
    if (!bot.symbols.includes(symbol)) setSymbol(bot.symbols[0] ?? "");
  }, [bot.symbols, symbol]);

  const load = useCallback(async () => {
    if (!symbol) return;
    try {
      const d = await api.klines({
        connectionId: bot.connectionId,
        symbol,
        interval,
        limit: 200,
      });
      setBars(d.bars);
      setError(null);
      setUpdatedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, [bot.connectionId, symbol, interval]);

  // 首次 + 参数变化时拉取；之后 30s 轮询
  useEffect(() => {
    setLoaded(false);
    void load();
    const t = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  // SSE 状态广播触发的节流刷新：机器人每几秒广播一次全量 state，K 线历史
  // 根本没变 —— 不能每次广播都重拉。这里用「bot 对象引用变化」（3s 轮询带来，
  // 与 SSE 等价）作为信号，60s 节流一次，覆盖"刚有成交想马上看到"的场景。
  useEffect(() => {
    if (bot.state.status !== "running") return;
    const now = Date.now();
    if (now - lastSseFetch.current < SSE_THROTTLE_MS) return;
    lastSseFetch.current = now;
    void load();
  }, [bot, load]);

  // 成交标记始终显示：这是「这台机器人到底按什么价位成交」的唯一可视化证据，
  // 藏起来只会在核对成交与 K 线关系时制造麻烦
  const trades: TradeMarker[] = useMemo(() => {
    return bot.state.trades
      .filter((t) => t.symbol === symbol)
      .map((t) => ({
        id: t.id,
        timestamp: t.timestamp,
        side: t.side,
        price: t.price,
        quantity: t.quantity,
        reason: t.reason,
      }));
  }, [bot.state.trades, symbol]);

  const ma = useMemo(
    () => ({ fastWindow: bot.strategy.fastWindow, slowWindow: bot.strategy.slowWindow }),
    [bot.strategy.fastWindow, bot.strategy.slowWindow],
  );

  const intervalOptions = INTERVALS.map((iv) => ({ value: iv, label: iv }));
  const symbolOptions = bot.symbols.map((s) => ({ value: s, label: s }));
  // 行情源要写在图上方：本地生成行情与真实主网行情长得一样，不标就会被当成实盘。
  const dataSourceLabel = bot.marketData === "simulated" ? "本地模拟行情" : "真实行情（主网）";

  return (
    <Panel
      title="K 线"
      subtitle={
        error
          ? undefined
          : `${dataSourceLabel} · ${bot.connectionLabel} · ${symbol || "—"} · ${interval}${updatedAt ? ` · 更新 ${time(updatedAt)}` : ""} · 涨跌标记来自本机器人成交流水`
      }
      actions={
        <div className="btn-row btn-row-auto" style={{ alignItems: "center", gap: 8 }}>
          {bot.symbols.length > 1 && (
            <div style={{ width: 160 }}>
              <Select value={symbol} options={symbolOptions} onChange={setSymbol} placeholder="选择标的" />
            </div>
          )}
          <div style={{ width: 88 }}>
            <Select value={interval} options={intervalOptions} onChange={(v: Interval) => setInterval_(v)} />
          </div>
          <Button small onClick={() => void load()} title="立即拉取最新 K 线">
            刷新
          </Button>
        </div>
      }
    >
      {error ? (
        <Empty>K 线拉取失败：{error}</Empty>
      ) : !loaded ? (
        <Empty>正在加载 K 线…</Empty>
      ) : bars.length === 0 ? (
        <Empty>这个连接没有返回 K 线 —— 检查标的代码与连接状态。</Empty>
      ) : (
        <KlineChart bars={bars} trades={trades} ma={ma} showVolume symbolLabel={symbol} />
      )}
    </Panel>
  );
}

/** 机器人周期不一定在可选清单里（如 15s），就近落到一个可画的周期。 */
function normalizeInterval(raw: string): Interval {
  const found = INTERVALS.find((iv) => iv === raw);
  if (found) return found;
  const n = Number.parseInt(raw, 10);
  const unit = raw.replace(/^\d+/, "");
  const sec = Number.isFinite(n) ? (unit === "h" ? n * 3600 : unit === "d" ? n * 86400 : n * 60) : 60;
  if (sec <= 60) return "1m";
  if (sec <= 300) return "5m";
  if (sec <= 900) return "15m";
  if (sec <= 3600) return "1h";
  if (sec <= 14400) return "4h";
  return "1d";
}
