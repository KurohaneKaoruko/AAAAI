import type { EngineState } from "../types";

const fmtMoney = (v: number) =>
  v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPct = (v: number) => `${(v * 100).toFixed(2)}%`;

export function MetricsCards({
  state,
  initialCash,
  symbol,
}: {
  state: EngineState | null;
  initialCash: number;
  symbol: string;
}) {
  const m = state?.metrics;
  const pnl = m ? m.finalEquity - initialCash : 0;
  const pnlPct = initialCash > 0 ? pnl / initialCash : 0;

  const cards = [
    { label: "总权益", value: m ? fmtMoney(m.finalEquity) : "—", accent: m && pnl >= 0 ? "up" : "down" },
    { label: "浮动盈亏", value: m ? `${pnl >= 0 ? "+" : ""}${fmtMoney(pnl)} (${fmtPct(pnlPct)})` : "—", accent: pnl >= 0 ? "up" : "down" },
    { label: "可用现金", value: m ? fmtMoney(m.cash) : "—" },
    { label: "最大回撤", value: m ? fmtPct(m.maxDrawdownPct) : "—", accent: m && m.maxDrawdownPct > 0.05 ? "warn" : undefined },
    { label: "成交笔数", value: m ? String(m.totalFills) : "—" },
    { label: "当前标的", value: symbol },
  ];

  return (
    <div className="cards">
      {cards.map((c) => (
        <div className="card" key={c.label}>
          <div className="card-label">{c.label}</div>
          <div className={`card-value ${c.accent ?? ""}`}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}
