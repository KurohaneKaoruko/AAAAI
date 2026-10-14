import assert from "node:assert/strict";
import test from "node:test";
import { EventBus, Topic } from "../src/core/eventBus.js";
import { StubSource } from "../src/data/stubSource.js";
import { PriceBook } from "../src/data/marketDataService.js";
import { PortfolioManager } from "../src/portfolio/portfolioManager.js";
import { PaperBroker } from "../src/execution/paperBroker.js";
import { BinanceBroker } from "../src/execution/binanceBroker.js";
import type { OrderIntent } from "../src/core/types.js";

test("StubSource: 同种子结果可复现，且 OHLC 自洽", async () => {
  const a = await new StubSource(7).fetchBars({ symbol: "T", limit: 50, interval: "1m" });
  const b = await new StubSource(7).fetchBars({ symbol: "T", limit: 50, interval: "1m" });
  assert.equal(a.length, 50);
  assert.deepEqual(
    a.map((x) => x.close),
    b.map((x) => x.close),
  );
  for (const bar of a) {
    assert.ok(bar.high >= Math.max(bar.open, bar.close) - 1e-9, `high 异常: ${JSON.stringify(bar)}`);
    assert.ok(bar.low <= Math.min(bar.open, bar.close) + 1e-9, `low 异常: ${JSON.stringify(bar)}`);
    assert.ok(bar.close > 0);
  }
  // 不同种子结果不同
  const c = await new StubSource(8).fetchBars({ symbol: "T", limit: 50, interval: "1m" });
  assert.notDeepEqual(
    a.map((x) => x.close),
    c.map((x) => x.close),
  );
});

test("PaperBroker: 成交含滑点与手续费，组合正确记账", async () => {
  const bus = new EventBus();
  const book = new PriceBook();
  const portfolio = new PortfolioManager(bus, 10_000);
  new PaperBroker(bus, book, { feeRate: 0.001, slippageBps: 10 });

  book.update({ symbol: "X", timestamp: new Date(), open: 100, high: 100, low: 100, close: 100, volume: 1 });
  const intent: OrderIntent = {
    symbol: "X",
    side: "BUY",
    quantity: 1,
    price: 100,
    timestamp: new Date(),
    reason: "test",
  };
  await bus.publishAsync(Topic.ORDER_INTENT, intent);

  // 滑点 +10bps: 100 * 1.001 = 100.1；手续费 0.1001
  assert.equal(portfolio.cash, 10_000 - 100.1 - 0.1001);
  const pos = portfolio.position("X");
  assert.ok(pos && Math.abs(pos.quantity - 1) < 1e-9);
  assert.equal(portfolio.metrics().totalFills, 1);
});

test("BinanceBroker: dryRun 下只模拟不请求", async () => {
  const bus = new EventBus();
  const portfolio = new PortfolioManager(bus, 10_000);
  const broker = new BinanceBroker(bus, {
    baseUrl: "https://testnet.binance.vision",
    apiKey: "",
    apiSecret: "",
    dryRun: true,
  });
  assert.equal(broker.paper, true);

  const fill = await broker.submit({
    symbol: "X",
    side: "BUY",
    quantity: 2,
    price: 50,
    timestamp: new Date(),
    reason: "test",
  });
  assert.ok(fill);
  assert.equal(fill.price, 50);
  assert.equal(fill.fee, 100 * 0.001);
  // 成交通过 FILL 事件进入组合
  assert.equal(portfolio.metrics().totalFills, 1);
  assert.equal(portfolio.cash, 10_000 - 100 - 0.1);
});

test("EventBus: ORDER_INTENT -> FILL 端到端", async () => {
  const bus = new EventBus();
  const book = new PriceBook();
  const portfolio = new PortfolioManager(bus, 5000);
  new PaperBroker(bus, book, { feeRate: 0, slippageBps: 0 });
  book.update({ symbol: "Y", timestamp: new Date(), open: 25, high: 25, low: 25, close: 25, volume: 1 });
  await bus.publishAsync(Topic.ORDER_INTENT, {
    symbol: "Y",
    side: "BUY",
    quantity: 4,
    price: 25,
    timestamp: new Date(),
    reason: "test",
  } satisfies OrderIntent);
  assert.equal(portfolio.cash, 5000 - 100);
});
