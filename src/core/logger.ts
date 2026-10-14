/** 统一日志：带级别与模块名的控制台输出，支持 printf 占位符。 */

import { format } from "node:util";

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: number = ORDER.info;

export function setLogLevel(level: string): void {
  threshold = ORDER[(level as Level) in ORDER ? (level as Level) : "info"] ?? ORDER.info;
}

function emit(level: Level, scope: string, args: unknown[]): void {
  if (ORDER[level] < threshold) return;
  const time = new Date().toTimeString().slice(0, 8);
  const tag = `${time} ${level.toUpperCase().padEnd(5)} ${scope} |`;
  const text = format(...args);
  // eslint-disable-next-line no-console
  (level === "debug" ? console.debug : level === "error" ? console.error : console.log)(tag, text);
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
