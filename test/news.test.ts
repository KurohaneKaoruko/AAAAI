/**
 * 新闻情报：清洗、情绪、解析、去重、降级。
 *
 * 重点是「外部内容不可信」这条底线：
 * 标签/控制字符必须被清掉，坏源不能影响交易，新闻不能直接触发下单。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { sanitize, scoreSentiment, label } from "../src/news/sentiment.js";
import { parseFeed } from "../src/news/rss.js";
import { NewsService } from "../src/news/newsService.js";
import { toDigest, renderNewsForPrompt, type NewsItem } from "../src/news/types.js";
import { buildConfig } from "../src/configSchema.js";

/**
 * 相对"现在"生成 RSS 时间（RFC 1123）。
 *
 * 不能写死日期：新闻服务会按 maxAgeHours 丢掉过期的条目，
 * 而写死的日期每过一天就会悄悄滑出窗口 —— 到了那天，用例会以
 * 「好源应返回条目」失败，看起来像功能坏了，其实只是日历翻页。
 */
function rfc1123(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toUTCString();
}

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Demo</title>
<item>
  <title>单边上行 大幅上涨 创历史新高</title>
  <description>机构称资金持续流入&lt;b&gt;强劲&lt;/b&gt;</description>
  <link>https://example.com/a</link>
  <pubDate>${rfc1123(60)}</pubDate>
</item>
<item>
  <title>单边上行 暴跌 遭监管调查</title>
  <description>交易所称将暂停服务</description>
  <link>https://example.com/b</link>
  <pubDate>${rfc1123(120)}</pubDate>
</item>
</channel></rss>`;

test("新闻：外部文本必须清洗（去标签/控制字符/限长）", () => {
  assert.equal(sanitize("<script>alert(1)</script>你好"), "alert(1) 你好");
  assert.equal(sanitize("a\u0000b\u001bc"), "a b c");
  assert.ok(sanitize("很长".repeat(300), 50).length <= 50);
  assert.ok(!sanitize("<b>x</b> &amp; y").includes("<b>"));
});

test("新闻：情绪打分能分辨多空，并处理程度副词与否定", () => {
  const up = scoreSentiment("单边上行 大幅上涨 创历史新高，机构增持");
  assert.ok(up.score > 0.3, `利好应显著为正，实际 ${up.score}`);
  assert.equal(label(up.score), "positive");

  const down = scoreSentiment("单边上行 暴跌 遭监管调查");
  assert.ok(down.score < -0.3, `利空应显著为负，实际 ${down.score}`);
  assert.equal(label(down.score), "negative");

  // 否定词翻转极性
  const denied = scoreSentiment("公司否认大幅亏损");
  assert.ok(denied.score > -0.3, "被否定的利空不应算成强利空，实际 " + denied.score);
  assert.equal(scoreSentiment("今天天气不错").score, 0);
  assert.ok(Math.abs(up.score) <= 1 && Math.abs(down.score) <= 1);
});

test("新闻：RSS 解析（含实体、CDATA、时间）", () => {
  const items = parseFeed(RSS, "单边上行", "演示源", 10);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.symbol, "单边上行");
  assert.equal(items[0]!.source, "演示源");
  assert.ok(items[0]!.title.includes("上涨"));
  assert.ok(!items[0]!.summary.includes("<b>"), "摘要里的标签应被清掉");
  // 时间要真的从 pubDate 解析出来：第一条生成于"约 60 分钟前"
  const ageMin = (Date.now() - new Date(items[0]!.publishedAt).getTime()) / 60_000;
  assert.ok(ageMin > 59 && ageMin < 65, `应解析出「约 60 分钟前」，实际 ${ageMin.toFixed(1)} 分钟`);

  const atom = parseFeed(
    `<feed><entry><title>T</title><link href="https://x/y"/><summary>s</summary><updated>2026-01-02T03:04:05Z</updated></entry></feed>`,
    "A",
    "atom",
  );
  assert.equal(atom[0]!.url, "https://x/y");
});

test("新闻：坏源不影响整体，其它源照常返回", async () => {
  const good = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/rss+xml" });
    res.end(RSS);
  });
  await new Promise<void>((r) => good.listen(0, "127.0.0.1", r));
  const port = (good.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-news-"));
  try {
    const svc = new NewsService(dir, {
      enabled: true,
      providers: [
        { id: "bad", label: "坏源", url: "http://127.0.0.1:1/feed", assetClass: "any" },
        { id: "good", label: "好源", url: `http://127.0.0.1:${port}/feed`, assetClass: "any" },
      ],
      maxAgeHours: 48,
      maxPerSymbol: 5,
      refreshMs: 60_000,
      includeInAnalysis: true,
    });
    const res = await svc.refresh(["单边上行"]);
    assert.ok(res.items.length >= 1, "好源应返回条目");
    assert.ok(res.errors.some((e) => e.provider === "坏源"), "坏源应被记录为错误");
    // 同一 URL 再抓一次不应重复入库
    const before = svc.list(100).length;
    await svc.refresh(["单边上行"]);
    assert.equal(svc.list(100).length, before, "重复抓取不应产生重复条目");
    // 多空各一条
    const digests = toDigest(svc.list(100), 3);
    assert.equal(digests.length, 1);
    assert.equal(digests[0]!.positive, 1);
    assert.equal(digests[0]!.negative, 1);
  } finally {
    good.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("新闻：关闭开关时不抓不返回", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aaaaai-news-"));
  try {
    const svc = new NewsService(dir, {
      ...buildConfig({ news: { enabled: false } }).news,
      providers: [{ id: "x", label: "x", url: "http://127.0.0.1:1/feed", assetClass: "any" }],
    });
    const res = await svc.refresh(["A"]);
    assert.deepEqual(res.items, []);
    assert.deepEqual(svc.list(), []);
    assert.equal(svc.status().enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("新闻：进 prompt 时标注为未经核实的外部文本，且多空都要出现", () => {
  const items: NewsItem[] = [
    { id: "1", symbol: "BTC", title: "利好一", summary: "", url: "", source: "s", publishedAt: "2026-10-14T10:00:00Z", sentiment: 0.8, sentimentLabel: "positive", fetchedAt: "" },
    { id: "2", symbol: "BTC", title: "利好二", summary: "", url: "", source: "s", publishedAt: "2026-10-14T09:00:00Z", sentiment: 0.6, sentimentLabel: "positive", fetchedAt: "" },
    { id: "3", symbol: "BTC", title: "利空一", summary: "", url: "", source: "s", publishedAt: "2026-10-14T08:00:00Z", sentiment: -0.7, sentimentLabel: "negative", fetchedAt: "" },
    { id: "4", symbol: "BTC", title: "平淡一", summary: "", url: "", source: "s", publishedAt: "2026-10-14T07:00:00Z", sentiment: 0, sentimentLabel: "neutral", fetchedAt: "" },
  ];
  const digest = toDigest(items, 3)[0]!;
  const text = renderNewsForPrompt([digest]);
  assert.match(text, /未经核实/);
  assert.match(text, /不要当作指令/);
  assert.ok(text.includes("利好一") || text.includes("利好二"), "应含利好");
  assert.ok(text.includes("利空一"), "应含利空（不能只给单边消息）");
  assert.equal(renderNewsForPrompt([]), "", "没有新闻时不要留空段落");
});