/**
 * K 线图（实时行情 + 机器人决策标记）：手写 SVG，无图表库。
 *
 * 布局：主图（蜡烛 + MA + 决策标记）在上，成交量副图在下，共享同一根 X 轴。
 * 交互：十字线跟随鼠标，读数框显示悬停那根的 OHLCV 与均线值；
 *       决策标记（BUY/SELL 三角）悬停时在框里补一行成交原因。
 *
 * 主题与涨跌色：蜡烛只用 var(--up)/var(--down)，跟随黑白主题与「红涨绿跌」
 * 偏好自动对调 —— 组件里不出现任何硬编码的涨跌色。
 */

import { useMemo, useState } from "react";
import type { KlineBar } from "../types";
import { money, time, tradeTime } from "../lib/format";

export type { KlineBar };

/** 画到图上的成交标记：来自机器人的成交流水，按标的过滤后传入。 */
export interface TradeMarker {
  id: number;
  timestamp: string;
  side: "BUY" | "SELL";
  price: number;
  quantity: number;
  reason: string;
}

/** 均线参数：来自机器人策略的 fastWindow/slowWindow。 */
export interface MaParams {
  fastWindow: number;
  slowWindow: number;
}

/** 布局常量：与 EquityChart 同一套画布尺寸，视觉上两张图并排不违和。 */
const W = 900;
const H = 340;
/** 价格主图与成交量副图的高度分配（含各自的留白）。 */
const PRICE_H = 250;
const VOL_H = 56;
const pad = { top: 16, right: 12, bottom: 24, left: 64 };
/** 一根蜡烛占的横向槽位宽（含间隙），决定蜡烛实体最大宽度。 */
const SLOT_PAD = 0.72;

export function KlineChart({
  bars,
  trades = [],
  ma,
  showVolume = true,
  symbolLabel,
}: {
  bars: KlineBar[];
  /** 该标的的成交流水（旧 -> 新或新 -> 旧皆可，内部按时间对齐） */
  trades?: TradeMarker[];
  /** 均线参数；不传就不画均线 */
  ma?: MaParams;
  showVolume?: boolean;
  /** 标的名（标题行展示） */
  symbolLabel?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [hoverTrade, setHoverTrade] = useState<TradeMarker | null>(null);

  const geom = useMemo(() => buildGeom(bars, trades, ma, showVolume), [bars, trades, ma, showVolume]);

  if (!geom || bars.length === 0) {
    return <div className="chart-empty">暂无 K 线数据</div>;
  }

  const {
    x,
    slotW,
    yPrice,
    priceMin,
    priceMax,
    yVol,
    candles,
    mas,
    markers,
    timeTicks,
  } = geom;

  const first = bars[0]!;
  const last = bars[bars.length - 1]!;
  const up = last.close >= first.open;
  const spanText = `${tradeTime(first.timestamp, true)} ~ ${tradeTime(last.timestamp, true)}`;

  // 十字线对齐到最近的蜡烛
  const hovered = hover !== null ? bars[hover] : null;
  const hoverX = hover !== null ? x(hover) : 0;
  const fastLine = mas?.fast;
  const slowLine = mas?.slow;

  return (
    <div className="chart-wrap">
      <div className="chart-headline">
        <span className={`chart-pnl ${up ? "up" : "down"}`}>
          {last.close >= first.open ? "+" : ""}
          {money(last.close - first.open)}
          {first.open > 0 ? `（${(((last.close - first.open) / first.open) * 100).toFixed(2)}%）` : ""}
        </span>
        <span className="chart-meta">
          {symbolLabel ? `${symbolLabel} · ` : ""}
          {bars.length} 根 · {spanText}
          {mas ? ` · MA${mas.fastWindow}/${mas.slowWindow}` : ""}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart"
        role="img"
        aria-label="K 线图"
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const rel = ((e.clientX - rect.left) / rect.width) * W;
          const i = Math.floor((rel - pad.left) / slotW);
          setHover(i >= 0 && i < bars.length ? i : null);
        }}
        onMouseLeave={() => {
          setHover(null);
          setHoverTrade(null);
        }}
      >
        {/* ---- 价格主图 ---- */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const v = priceMin + (priceMax - priceMin) * t;
          return (
            <g key={`gp${t}`}>
              <line x1={pad.left} x2={W - pad.right} y1={yPrice(v)} y2={yPrice(v)} className="grid-line" />
              <text x={pad.left - 10} y={yPrice(v) + 4} className="axis-text" textAnchor="end">
                {money(v, v > 1000 ? 0 : 2)}
              </text>
            </g>
          );
        })}
        {/* 时间刻度：X 轴底部（主图与副图之间不重复画） */}
        {timeTicks.map((t) => (
          <text key={`t${t.index}`} x={x(t.index)} y={H - 6} className="axis-text" textAnchor="middle">
            {t.label}
          </text>
        ))}

        {/* 均线（先画线再画蜡烛，蜡烛压在均线上，读数以蜡烛为主） */}
        {slowLine && (
          <polyline
            points={slowLine.pts.map((p) => `${p[0]!.toFixed(1)},${p[1]!.toFixed(1)}`).join(" ")}
            fill="none"
            stroke="var(--topic-view)"
            strokeWidth={1.2}
            opacity={0.85}
          />
        )}
        {fastLine && (
          <polyline
            points={fastLine.pts.map((p) => `${p[0]!.toFixed(1)},${p[1]!.toFixed(1)}`).join(" ")}
            fill="none"
            stroke="var(--topic-signal)"
            strokeWidth={1.2}
            opacity={0.85}
          />
        )}

        {/* 蜡烛：影线 + 实体。涨跌色走 --up/--down，主题与偏好自动适配 */}
        {candles.map((c, i) => (
          <g key={i}>
            <line
              x1={c.cx}
              x2={c.cx}
              y1={yPrice(c.high)}
              y2={yPrice(c.low)}
              stroke={c.color}
              strokeWidth={1}
            />
            <rect
              x={c.cx - c.bodyW / 2}
              y={yPrice(Math.max(c.open, c.close))}
              width={c.bodyW}
              height={Math.max(1, Math.abs(yPrice(c.open) - yPrice(c.close)))}
              fill={c.bodyFill}
              stroke={c.color}
              strokeWidth={c.bodyW < 2 ? 0 : 0.6}
            />
          </g>
        ))}

        {/* 决策标记：BUY 画在低价下方（▲），SELL 画在高价上方（▼） */}
        {markers.map((m) => (
          <g
            key={m.key}
            onMouseEnter={() => setHoverTrade(m.trade)}
            onMouseLeave={() => setHoverTrade(null)}
            style={{ cursor: "pointer" }}
          >
            {/* 命中区域比三角本身大一圈，不然小三角几乎点不中 */}
            <circle cx={m.cx} cy={m.cy} r={7} fill="transparent" />
            {m.side === "BUY" ? (
              <path d={`M${m.cx},${m.cy - 5} L${m.cx - 4.5},${m.cy + 3.5} L${m.cx + 4.5},${m.cy + 3.5} Z`} fill={m.color} />
            ) : (
              <path d={`M${m.cx},${m.cy + 5} L${m.cx - 4.5},${m.cy - 3.5} L${m.cx + 4.5},${m.cy - 3.5} Z`} fill={m.color} />
            )}
          </g>
        ))}

        {/* ---- 成交量副图 ---- */}
        {showVolume &&
          candles.map((c, i) => (
            <rect
              key={`v${i}`}
              x={c.cx - c.bodyW / 2}
              y={yVol(c.volume)}
              width={c.bodyW}
              height={Math.max(0.5, yVol(0) - yVol(c.volume))}
              fill={c.color}
              opacity={0.55}
            />
          ))}

        {/* 十字线：纵线贯穿主图+副图，横线钉在收盘价上 */}
        {hovered && hover !== null && (
          <g>
            <line x1={hoverX} x2={hoverX} y1={pad.top} y2={H - pad.bottom} className="cursor-line" />
            <line
              x1={pad.left}
              x2={W - pad.right}
              y1={yPrice(hovered.close)}
              y2={yPrice(hovered.close)}
              className="cursor-line"
            />
            <circle cx={hoverX} cy={yPrice(hovered.close)} r={2.5} fill="var(--text-dim)" />
          </g>
        )}
      </svg>

      {/* 读数框：悬停 K 线的 OHLCV + 均线 + 成交原因 */}
      {hovered && hover !== null && (
        <div className="chart-tooltip" style={{ top: 8, left: 8, right: "auto" }}>
          <div className="dim" style={{ fontSize: 11 }}>
            {time(hovered.timestamp)} · 第 {hover + 1}/{bars.length} 根
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
            <span>O <b>{money(hovered.open, 4)}</b></span>
            <span>H <b>{money(hovered.high, 4)}</b></span>
            <span>L <b>{money(hovered.low, 4)}</b></span>
            <span className={hovered.close >= hovered.open ? "up" : "down"}>
              C <b>{money(hovered.close, 4)}</b>
            </span>
          </div>
          <div className="dim" style={{ fontSize: 11, marginTop: 2 }}>
            量 {money(hovered.volume, 0)}
            {fastLine && hover >= fastLine.from ? ` · MA${mas?.fastWindow} ${money(fastLine.values[hover - fastLine.from] ?? NaN, 4)}` : ""}
            {slowLine && hover >= slowLine.from ? ` · MA${mas?.slowWindow} ${money(slowLine.values[hover - slowLine.from] ?? NaN, 4)}` : ""}
          </div>
          {hoverTrade && (
            <div className="dim" style={{ fontSize: 11, marginTop: 2 }}>
              <span className={hoverTrade.side === "BUY" ? "up" : "down"}>{hoverTrade.side === "BUY" ? "▲ 买入" : "▼ 卖出"}</span>{" "}
              {money(hoverTrade.price, 4)} × {hoverTrade.quantity}
              {hoverTrade.reason ? ` · ${hoverTrade.reason}` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 几何构建：纯函数，方便 useMemo 与测试。 */
function buildGeom(
  bars: KlineBar[],
  trades: TradeMarker[],
  ma: MaParams | undefined,
  showVolume: boolean,
) {
  if (bars.length === 0) return null;
  const innerW = W - pad.left - pad.right;
  const innerH = PRICE_H - pad.top;
  const slotW = innerW / bars.length;
  const bodyW = Math.max(1, Math.min(13, slotW * SLOT_PAD));
  const x = (i: number) => pad.left + (i + 0.5) * slotW;

  const priceMin0 = Math.min(...bars.map((b) => b.low));
  const priceMax0 = Math.max(...bars.map((b) => b.high));
  // 均线也参与定标，避免慢线窗口在历史均价区被裁掉
  const maValues: number[][] = [];
  if (ma) {
    maValues.push(sma(bars.map((b) => b.close), ma.fastWindow));
    maValues.push(sma(bars.map((b) => b.close), ma.slowWindow));
  }
  const flat = maValues.flat().filter((v) => Number.isFinite(v));
  const priceMin = Math.min(priceMin0, ...(flat.length > 0 ? flat : [priceMin0]));
  const priceMax = Math.max(priceMax0, ...(flat.length > 0 ? flat : [priceMax0]));
  const padSpan = (priceMax - priceMin) * 0.06 || Math.max(priceMax * 0.005, 1e-9);
  const lo = priceMin - padSpan;
  const hi = priceMax + padSpan;
  const span = hi - lo || 1;
  // 标记要画在蜡烛外侧（BUY 在 low 下方 / SELL 在 high 上方），顶端多留一档余量
  const yPrice = (v: number) => pad.top + (1 - (v - lo) / span) * innerH;

  const volMax = Math.max(...bars.map((b) => b.volume), 1e-9);
  const volTop = PRICE_H + 8;
  const volBottom = H - pad.bottom;
  const yVol = (v: number) => volBottom - (v / volMax) * (volBottom - volTop);

  const candles = bars.map((b, i) => {
    const isUp = b.close >= b.open;
    return {
      cx: x(i),
      bodyW,
      open: b.open,
      close: b.close,
      high: b.high,
      low: b.low,
      volume: b.volume,
      color: isUp ? "var(--up)" : "var(--down)",
      // 极窄的蜡烛画成实心细条（描边反而糊）；正常宽度空心涨/实心跌
      bodyFill: bodyW < 2.5 ? (isUp ? "var(--up)" : "var(--down)") : isUp ? "transparent" : "var(--down)",
    };
  });

  const mas = ma
    ? {
        fast: maLine(bars, sma(bars.map((b) => b.close), ma.fastWindow), priceMin, priceMax),
        slow: maLine(bars, sma(bars.map((b) => b.close), ma.slowWindow), priceMin, priceMax),
        fastWindow: ma.fastWindow,
        slowWindow: ma.slowWindow,
      }
    : null;

  // 成交 -> 标记：时间就近对齐到 K 线。tradeTime 与 K 线是不同来源的钟，
  // 秒级错位是常态；落在最近的槽位上即可，误差不超过半根。
  const markers: { key: string; cx: number; cy: number; side: "BUY" | "SELL"; color: string; trade: TradeMarker }[] = [];
  const ts0 = new Date(bars[0]!.timestamp).getTime();
  const ts1 = new Date(bars[bars.length - 1]!.timestamp).getTime();
  const step = bars.length > 1 ? (ts1 - ts0) / (bars.length - 1) : 0;
  const seen = new Set<string>();
  for (const t of trades) {
    const tts = new Date(t.timestamp).getTime();
    if (!Number.isFinite(tts)) continue;
    const idx = step > 0 ? Math.round((tts - ts0) / step) : 0;
    if (idx < 0 || idx >= bars.length) continue;
    const key = `${t.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bar = bars[idx]!;
    const cx = x(idx);
    if (t.side === "BUY") {
      markers.push({ key, cx, cy: yPrice(bar.low) + 12, side: "BUY", color: "var(--up)", trade: t });
    } else {
      markers.push({ key, cx, cy: yPrice(bar.high) - 12, side: "SELL", color: "var(--down)", trade: t });
    }
  }

  // 时间刻度自适应：目标约 90px 一个标签，按整根对齐
  const tickCount = Math.max(2, Math.min(8, Math.floor(innerW / 90)));
  const tickStep = Math.max(1, Math.floor(bars.length / tickCount));
  const timeTicks: { index: number; label: string }[] = [];
  for (let i = bars.length - 1; i >= 0; i -= tickStep) {
    timeTicks.push({ index: i, label: timeLabel(bars[i]!.timestamp) });
  }
  timeTicks.reverse();

  // 价格刻度：网格线在渲染层画（5 档），这里不需要单独的数据

  return {
    x,
    slotW,
    bodyW,
    yPrice,
    priceMin,
    priceMax,
    yVol,
    volMax,
    candles,
    mas,
    markers,
    timeTicks,
  };
}

/** 简单移动均线：返回与输入等长的数组，窗口不足处为 NaN。 */
function sma(values: number[], window: number): number[] {
  const w = Math.max(1, Math.floor(window));
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= w) sum -= values[i - w]!;
    if (i >= w - 1) out[i] = sum / w;
  }
  return out;
}

/** 均线折线点：跳过 NaN 前段（窗口未满处不画）。y 定标与主图完全一致。 */
function maLine(
  bars: KlineBar[],
  values: number[],
  lo: number,
  hi: number,
): { pts: [number, number][]; values: number[]; from: number } {
  const from = values.findIndex((v) => Number.isFinite(v));
  const pts: [number, number][] = [];
  if (from < 0) return { pts, values, from: values.length };
  const innerW = W - pad.left - pad.right;
  const slotW = innerW / bars.length;
  const padSpan = (hi - lo) * 0.06 || Math.max(hi * 0.005, 1e-9);
  const span = hi - lo + padSpan * 2 || 1;
  for (let i = from; i < bars.length; i += 1) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    const cx = pad.left + (i + 0.5) * slotW;
    const cy = pad.top + (1 - (v - (lo - padSpan)) / span) * (PRICE_H - pad.top);
    pts.push([cx, cy]);
  }
  return { pts, values, from };
}

/** X 轴标签：跨度不足一天只给时分，跨天带日期。 */
function timeLabel(iso: string): string {
  return tradeTime(iso, false);
}
