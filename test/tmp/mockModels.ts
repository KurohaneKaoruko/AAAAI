/**
 * 本地假模型服务（仅用于手工验证，不参与 npm test）。
 *
 * 同时提供两种协议，把收到的 prompt/state 记到 /tmp/mock-models.log：
 * - POST /v1/chat/completions   对话模型（分析端 / 决策端）
 * - POST /v1/systemone         System One 决策模型
 *
 * 用法：setsid npx tsx test/tmp/mockModels.ts
 */
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const PORT = 8899;
let seq = 0;
const log = (line: string): void => appendFileSync("/tmp/mock-models.log", `${new Date().toISOString()} ${line}\n`);

const ANALYSIS = JSON.stringify({
  summary: "DEMO-BTC 均线多头，DEMO-ETH 走弱",
  views: [
    { symbol: "DEMO-BTC", view: "均线多头排列，量能温和放大", strength: "strong", confidence: 0.8 },
    { symbol: "DEMO-ETH", view: "跌破短均线，量能萎缩", strength: "weak", confidence: 0.65 },
  ],
  ranking: ["DEMO-BTC", "DEMO-ETH"],
});

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const id = ++seq;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      /* 忽略 */
    }

    if (req.url?.endsWith("/chat/completions")) {
      const prompt = String((parsed.messages as { content: string }[] | undefined)?.[0]?.content ?? "");
      const isAnalysis = /行情分析师/.test(prompt);
      log(`[chat #${id}] 角色=${isAnalysis ? "分析(不给仓位)" : "决策/点评"} 长度=${prompt.length}`);
      const content = isAnalysis
        ? ANALYSIS
        : JSON.stringify({ allocations: { "DEMO-BTC": 0.45 }, confidence: 0.72, reason: "对话模型决策" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      return;
    }

    if (req.url?.endsWith("/systemone")) {
      const state = String(parsed.state ?? "");
      const questions = (parsed.questions ?? {}) as Record<string, unknown>;
      const gotAnalysis = /大模型行情分析/.test(state);
      const key = Object.keys(questions);
      log(`[so   #${id}] 问题数=${key.length} 收到大模型分析=${gotAnalysis}`);
      if (gotAnalysis) {
        log(`   分析片段: ${state.split("\n").filter((l) => /整体判断|强弱排序|技术面强弱|影响力/.test(l)).join(" | ").slice(0, 240)}`);
      }
      const answers: Record<string, unknown> = {};
      for (const [k, q] of Object.entries(questions)) {
        const levels = (q as { levels?: string[] }).levels ?? ["weak", "moderate", "strong"];
        const idx = key.indexOf(k);
        answers[k] = {
          level: levels[idx === 0 ? 2 : 0],
          confidence: 0.8,
          probabilities: levels.map((_, i) => (i === (idx === 0 ? 2 : 0) ? 0.75 : 0.125)),
        };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answers, elapsedMs: 10 }));
      return;
    }

    res.writeHead(404).end("{}");
  });
}).listen(PORT, "127.0.0.1", () => log(`mock model server on ${PORT}`));