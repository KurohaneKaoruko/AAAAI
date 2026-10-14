/** 持仓表：按「本次运行的标记价」计算浮动盈亏，避免与实时报价混算。 */

import type { Position } from "../types";
import { Empty } from "./ui";
import { money, pct, qty, signed } from "../lib/format";

export function PositionsTable({
  positions,
  prices,
  equity,
}: {
  positions: Position[];
  /** 引擎运行价（PriceBook 快照），回测/实时一致 */
  prices: Record<string, number>;
  equity: number;
}) {
  if (positions.length === 0) return <Empty>当前无持仓</Empty>;

  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>标的</th>
            <th className="num">数量</th>
            <th className="num">成本价</th>
            <th className="num">标记价</th>
            <th className="num">市值</th>
            <th className="num">浮动盈亏</th>
            <th className="num">仓位</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const mark = prices[p.symbol] ?? p.avgCost;
            const value = p.quantity * mark;
            const pnl = (mark - p.avgCost) * p.quantity;
            const pnlPct = p.avgCost > 0 ? (mark - p.avgCost) / p.avgCost : 0;
            const weight = equity > 0 ? value / equity : 0;
            return (
              <tr key={p.symbol}>
                <td className="mono strong">{p.symbol}</td>
                <td className="mono num">{qty(p.quantity)}</td>
                <td className="mono num">{money(p.avgCost, 4)}</td>
                <td className="mono num">{money(mark, 4)}</td>
                <td className="mono num">{money(value)}</td>
                <td className={`mono num ${pnl >= 0 ? "up" : "down"}`}>
                  {signed(pnl)}
                  <span className="dim"> ({pct(pnlPct)})</span>
                </td>
                <td className="mono num dim">{pct(weight, 1)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}