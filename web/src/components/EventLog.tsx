import { useEffect, useRef } from "react";
import type { EngineEventLine } from "../types";

const TOPIC_LABEL: Record<string, string> = {
  "market.bar": "K线",
  "agent.market_view": "分析",
  "strategy.signal": "信号",
  "exec.order_intent": "下单",
  "exec.order_rejected": "拒单",
  "exec.fill": "成交",
  "engine.status": "引擎",
};

export function EventLog({ events }: { events: EngineEventLine[] }) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: 0 });
  }, [events.length]);

  return (
    <div className="panel panel-grow">
      <div className="panel-title">
        事件流
        <span className="panel-sub">{events.length} 条（实时）</span>
      </div>
      <div className="event-log" ref={boxRef}>
        {events.length === 0 && <div className="empty">等待引擎事件…</div>}
        {events.map((e) => (
          <div className="event-row" key={`${e.seq}-${e.topic}`}>
            <span className="event-time">{e.timestamp.slice(11, 19)}</span>
            <span className={`event-topic topic-${e.topic}`}>{TOPIC_LABEL[e.topic] ?? e.topic}</span>
            <span className="event-summary">{e.summary}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
