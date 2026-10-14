import type { EquityPoint } from "../types";

/** 权益曲线：纯 SVG，无图表库依赖。 */
export function EquityChart({
  curve,
  initialCash,
}: {
  curve: EquityPoint[];
  initialCash: number;
}) {
  const width = 720;
  const height = 240;
  const pad = { top: 16, right: 16, bottom: 24, left: 56 };

  if (curve.length < 2) {
    return (
      <div className="panel">
        <div className="panel-title">权益曲线</div>
        <div className="empty">暂无数据 —— 点击「启动回测」生成权益曲线</div>
      </div>
    );
  }

  const values = curve.map((p) => p.equity);
  const min = Math.min(...values, initialCash);
  const max = Math.max(...values, initialCash);
  const span = max - min || 1;
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const x = (i: number) => pad.left + (i / (curve.length - 1)) * innerW;
  const y = (v: number) => pad.top + (1 - (v - min) / span) * innerH;

  const line = curve.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(" ");
  const area = `${line} L${x(curve.length - 1).toFixed(1)},${(height - pad.bottom).toFixed(1)} L${pad.left},${(height - pad.bottom).toFixed(1)} Z`;
  const last = curve[curve.length - 1]!;
  const up = last.equity >= curve[0]!.equity;
  const color = up ? "#3fb27f" : "#e5534b";

  const timeFmt = (iso: string) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <div className="panel">
      <div className="panel-title">
        权益曲线
        <span className="panel-sub">
          {curve.length} 点 · {timeFmt(curve[0]!.timestamp)} → {timeFmt(last.timestamp)} · 区间{" "}
          {min.toFixed(2)} ~ {max.toFixed(2)}
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="chart" role="img" aria-label="权益曲线">
        <defs>
          <linearGradient id="eqfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const v = min + span * t;
          return (
            <g key={t}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={y(v)}
                y2={y(v)}
                className="grid-line"
              />
              <text x={pad.left - 8} y={y(v) + 4} className="axis-text" textAnchor="end">
                {v.toFixed(0)}
              </text>
            </g>
          );
        })}
        <path d={area} fill="url(#eqfill)" />
        <path d={line} fill="none" stroke={color} strokeWidth={1.8} />
        <circle cx={x(curve.length - 1)} cy={y(last.equity)} r={3.5} fill={color} />
      </svg>
    </div>
  );
}
