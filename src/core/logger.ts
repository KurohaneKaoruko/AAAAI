/** 统一日志：带级别、模块名、printf 占位符，并保留环形缓冲供 WebUI 查看。 */

import { format } from "node:util";

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: number = ORDER.info;

const RING_LIMIT = 1000;
const ring: { time: string; level: Level; scope: string; message: string }[] = [];

export interface LogLine {
  time: string;
  level: Level;
  scope: string;
  message: string;
}

export function setLogLevel(level: string): void {
  const key = level as Level;
  threshold = ORDER[key] ?? ORDER.info;
}

/** 读取最近的日志（新的在前）。 */
export function logLines(limit = 200): LogLine[] {
  return ring.slice(-limit).reverse();
}

function emit(level: Level, scope: string, args: unknown[]): void {
  const time = new Date().toISOString();
  const message = format(...args);
  ring.push({ time, level, scope, message });
  if (ring.length > RING_LIMIT) ring.shift();
  if (ORDER[level] < threshold) return;
  const tag = `${time.slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${scope} |`;
  // eslint-disable-next-line no-console
  (level === "debug" ? console.debug : level === "error" ? console.error : console.log)(tag, message);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(scope: string): Logger;
}

export function getLogger(scope: string): Logger {
  return {
    debug: (...a) => emit("debug", scope, a),
    info: (...a) => emit("info", scope, a),
    warn: (...a) => emit("warn", scope, a),
    error: (...a) => emit("error", scope, a),
    child: (sub: string) => getLogger(`${scope}:${sub}`),
  };
}