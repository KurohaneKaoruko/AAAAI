/** 成交流水：含已实现盈亏。 */

import type { TradeRecord } from "../types";
import { Empty } from "./ui";
import { money, qty, signed, tradeTime } from "../lib/format";

export function TradesTable({ trades }: { trades: TradeRecord[] }) {
  if (trades.length === 0) return <Empty>暂无成交流水</Empty>;
  const shown = trades.slice(0, 200);
  // 跨天才带日期：日线行情下所有 K 线都是同一时刻，只给时分秒会像"同一秒成交一堆单"
  const spanDays = new Set(shown.map((t) => t.timestamp.slice(0, 10))).size > 1;
  return (
    <div className="table-scroll table-scroll-tall">
      <table className="table">
        <thead>
          <tr>
            <th>时间</th>
            <th>方向</th>
            <th>标的</th>
            <th className="num">数量</th>
            <th className="num">成交价</th>
            <th className="num">手续费</th>
            <th className="num">已实现盈亏</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((t) => (
            <tr key={t.id}>
              <td className="mono dim">{tradeTime(t.timestamp, spanDays)}</td>
              <td>
                <span className={`side-tag ${t.side === "BUY" ? "side-buy" : "side-sell"}`}>
                  {t.side === "BUY" ? "买入" : "卖出"}
                </span>
              </td>
              <td className="mono strong">{t.symbol}</td>
              <td className="mono num">{qty(t.quantity)}</td>
              <td className="mono num">{money(t.price, 4)}</td>
              <td className="mono num dim">{money(t.fee, 4)}</td>
              <td className={`mono num ${t.realizedPnl > 0 ? "up" : t.realizedPnl < 0 ? "down" : "dim"}`}>
                {t.realizedPnl === 0 ? "—" : signed(t.realizedPnl)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}