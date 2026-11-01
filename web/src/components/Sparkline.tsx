/**
 * 迷你走势图：一条手写 SVG 折线，塞在指标卡/表格单元格里。
 *
 * 为什么不直接用 EquityChart 缩小：那张图带坐标轴、悬停、基准线，
 * 缩到 40px 高全糊成一团。这里只保留「最近在涨还是在跌」这一个信息，
 * 颜色跟行情方向色（--up/--down），不新增任何语义。
 */

import { useMemo } from "react";

export function Sparkline({
  values,
  width = 72,
  height = 26,
  className = "",
}: {
  /** 时间正序的数值序列；少于 2 个点画不出来，静默返回空（卡片不该为了它报错） */
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  const geom = useMemo(() => {
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || Math.abs(max) * 0.01 || 1;
    const padY = 2;
    const x = (i: number) => (i / (values.length - 1)) * (width - 2) + 1;
    const y = (v: number) => padY + (1 - (v - min) / span) * (height - padY * 2);
    const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const area = `${line} L${x(values.length - 1).toFixed(1)},${height} L1,${height} Z`;
    return { line, area, last: values[values.length - 1]!, first: values[0]! };
  }, [values, width, height]);

  if (!geom) return null;
  const up = geom.last >= geom.first;
  const color = up ? "var(--up)" : "var(--down)";

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={`spark ${className}`}
      aria-hidden="true"
    >
      <path d={geom.area} fill={color} className="spark-fill" />
      <path d={geom.line} stroke={color} className="spark-line" />
    </svg>
  );
}
