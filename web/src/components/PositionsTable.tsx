import type { Position } from "../types";

export function PositionsTable({
  positions,
  prices,
}: {
  positions: Position[];
  prices: Record<string, number>;
}) {
  if (positions.length === 0) {
    return (
      <div className="panel">
        <div className="panel-title">持仓</div>
        <div className="empty">当前无持仓</div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-title">持仓</div>
      <table className="table">
        <thead>
          <tr>
            <th>标的</th>
            <th>数量</th>
            <th>成本价</th>
            <th>最新价</th>
            <th>市值</th>
            <th>浮动盈亏</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const mark = prices[p.symbol] ?? p.avgCost;
            const value = p.quantity * mark;
            const pnl = (mark - p.avgCost) * p.quantity;
            return (
              <tr key={p.symbol}>
                <td className="mono">{p.symbol}</td>
                <td className="mono">{p.quantity.toFixed(6)}</td>
                <td className="mono">{p.avgCost.toFixed(4)}</td>
                <td className="mono">{mark.toFixed(4)}</td>
                <td className="mono">{value.toFixed(2)}</td>
                <td className={`mono ${pnl >= 0 ? "up" : "down"}`}>
                  {pnl >= 0 ? "+" : ""}
                  {pnl.toFixed(2)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
