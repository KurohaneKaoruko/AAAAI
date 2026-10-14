/** 事件流：按主题过滤 + 自动滚动。 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { EngineEventLine } from "../types";
import { Empty } from "./ui";
import { TOPIC_LABEL, time } from "../lib/format";

const FILTERS: { id: string; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "market.bar", label: "K线" },
  { id: "agent.market_view", label: "分析" },
  { id: "strategy.signal", label: "信号" },
  { id: "exec.order_intent", label: "下单" },
  { id: "exec.fill", label: "成交" },
  { id: "exec.order_rejected", label: "拒单" },
];

export function EventLog({ events }: { events: EngineEventLine[] }) {
  const [filter, setFilter] = useState("all");
  const boxRef = useRef<HTMLDivElement>(null);

  const list = useMemo(
    () => (filter === "all" ? events : events.filter((e) => e.topic === filter)),
    [events, filter],
  );

  useEffect(() => {
    boxRef.current?.scrollTo({ top: 0 });
  }, [events.length]);

  return (
    <>
      <div className="filter-bar">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`filter-chip ${filter === f.id ? "filter-active" : ""}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
        <span className="filter-count">{list.length} 条</span>
      </div>
      <div className="event-log" ref={boxRef}>
        {list.length === 0 && <Empty>等待引擎事件…</Empty>}
        {list.map((e) => (
          <div className="event-row" key={`${e.seq}-${e.topic}`}>
            <span className="event-time mono">{time(e.timestamp)}</span>
            <span className={`event-topic topic-${e.topic}`}>{TOPIC_LABEL[e.topic] ?? e.topic}</span>
            <span className="event-summary mono">{e.summary}</span>
          </div>
        ))}
      </div>
    </>
  );
}