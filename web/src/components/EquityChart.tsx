/** 权益曲线：手写 SVG，含坐标轴、初始资金基准线、悬停提示。 */

import { useMemo, useState } from "react";
import type { EquityPoint } from "../types";
import { money } from "../lib/format";

export function EquityChart({ curve, initialCash }: { curve: EquityPoint[]; initialCash: number }) {
  const [hover, setHover] = useState<number | null>(null);

  const W = 900;
  const H = 260;
  const pad = { top: 18, right: 20, bottom: 26, left: 64 };

  const geom = useMemo(() => {
    if (curve.length < 2) return null;
    const values = curve.map((p) => p.equity);
    const min = Math.min(...values, initialCash);
    const max = Math.max(...values, initialCash);
    const span = max - min || Math.max(max * 0.01, 1);
    const innerW = W - pad.left - pad.right;
    const innerH = H - pad.top - pad.bottom;
    const x = (i: number) => pad.left + (i / (curve.length - 1)) * innerW;
    const y = (v: number) => pad.top + (1 - (v - min) / span) * innerH;
    const line = curve.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(" ");
    const area = `${line} L${x(curve.length - 1).toFixed(1)},${(H - pad.bottom).toFixed(1)} L${pad.left},${(H - pad.bottom).toFixed(1)} Z`;
    return { min, max, x, y, line, area };
  }, [curve, initialCash]);

  if (!geom) {
    return (
      <div className="chart-empty">
        暂无权益数据 —— 在「策略 → 候选池」添加标的后运行一次回测
      </div>
    );
  }

  const first = curve[0]!.equity;
  const last = curve[curve.length - 1]!.equity;
  const up = last >= first;
  const color = up ? "var(--up)" : "var(--down)";
  const hovered = hover === null ? null : curve[hover];
  const totalPnl = initialCash > 0 ? (last - initialCash) / initialCash : 0;

  return (
    <div className="chart-wrap">
      <div className="chart-headline">
        <span className={`chart-pnl ${up ? "up" : "down"}`}>
          {up ? "+" : ""}
          {money(last - initialCash)}（{(totalPnl * 100).toFixed(2)}%）
        </span>
        <span className="chart-meta">
          {curve.length} 个数据点 · 区间 {money(geom.min)} ~ {money(geom.max)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart"
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const rel = ((e.clientX - rect.left) / rect.width) * W;
          const innerW = W - pad.left - pad.right;
          const i = Math.round(((rel - pad.left) / innerW) * (curve.length - 1));
          setHover(i >= 0 && i < curve.length ? i : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="eqfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0.01" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const v = geom.min + (geom.max - geom.min) * t;
          return (
            <g key={t}>
              <line x1={pad.left} x2={W - pad.right} y1={geom.y(v)} y2={geom.y(v)} className="grid-line" />
              <text x={pad.left - 10} y={geom.y(v) + 4} className="axis-text" textAnchor="end">
                {money(v, 0)}
              </text>
            </g>
          );
        })}
        {/* 初始资金基准线 */}
        <line
          x1={pad.left}
          x2={W - pad.right}
          y1={geom.y(initialCash)}
          y2={geom.y(initialCash)}
          className="baseline-line"
        />
        <text x={W - pad.right} y={geom.y(initialCash) - 6} className="axis-text" textAnchor="end">
          初始 {money(initialCash, 0)}
        </text>

        <path d={geom.area} fill="url(#eqfill)" />
        <path d={geom.line} fill="none" stroke={color} strokeWidth={2} />

        {hovered && hover !== null && (
          <>
            <line x1={geom.x(hover)} x2={geom.x(hover)} y1={pad.top} y2={H - pad.bottom} className="cursor-line" />
            <circle cx={geom.x(hover)} cy={geom.y(hovered.equity)} r={4} fill={color} />
          </>
        )}
      </svg>
      {hovered && hover !== null && (
        <div className="chart-tooltip">
          {new Date(hovered.timestamp).toLocaleString("zh-CN")} · 权益 {money(hovered.equity)}
        </div>
      )}
    </div>
  );
}