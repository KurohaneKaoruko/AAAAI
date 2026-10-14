# 架构说明

## 分层

```
┌──────────────────────────────────────────────────────────────┐
│ WebUI (React+Vite)      web/          SSE + REST             │  界面
├──────────────────────────────────────────────────────────────┤
│ Server                  src/server/   Express + 引擎控制器     │  接入层
├──────────────────────────────────────────────────────────────┤
│ Backtest                src/backtest/                         │  回测
│ Agents                  src/agents/   分析师/策略/风控/装配    │  智能体
│ Strategies              src/strategies/ momentum / llm       │  可插拔策略
│ Risk                    src/risk/                            │  风控红线
│ Portfolio               src/portfolio/                       │  记账与权益曲线
│ Execution               src/execution/  paper / binance      │  券商
│ Data                    src/data/       stub / binance       │  数据源
├──────────────────────────────────────────────────────────────┤
│ Core                    src/core/       EventBus / 类型 / 日志 │  内核
└──────────────────────────────────────────────────────────────┘
```

## 通信约定

Agent 之间**不允许**直接引用对方实例（装配层 `orchestrator.ts` 与控制器除外），一律通过 EventBus 广播：

| Topic | 载荷 | 生产者 | 消费者 |
| --- | --- | --- | --- |
| `market.bar` | `Bar` | `streamBars` / `LivePoller` | Analyst / Strategist / Portfolio |
| `agent.market_view` | `MarketView` | `MarketAnalystAgent` | `StrategistAgent` |
| `strategy.signal` | `Signal` | `StrategistAgent` | `RiskGuardAgent` |
| `exec.order_intent` | `OrderIntent` | `RiskGuardAgent` | Broker |
| `exec.order_rejected` | `Signal | OrderIntent` | 各处 | 监控（预留） |
| `exec.fill` | `Fill` | Broker | `PortfolioManager` |

- `publish` 同步派发；`publishAsync` 顺序 await 每个处理器，流水线统一使用后者保证顺序确定。
- EventBus 全量留痕（上限 5000），WebUI 事件流即由控制器转发而来。

## 关键流程

**回测**：`runBacktest(config)` → `buildPipeline` → 一次性 `fetchBars` → `streamBars` 逐根广播 → 汇总 `metrics`。

**实时**：`EngineController.start('live')` → 先拉 `bar_count` 根预热 → `LivePoller` 每 `poll_ms` 拉新收盘 K 线 → 广播 → 刷新状态 → 回撤越限自动 `stop()`。

**LLM 决策**：`LLMStrategy` 包装饰动量基线；命中 `decision_interval` 时才请求 LLM，输出 JSON 决策；失败/非法 → 回落基线并打 `[fallback]` 标记。

**实盘下单**：`BinanceBroker` 仅当 `broker=binance && dryRun=false && Key 齐全` 时真实签名下单；否则以 dry-run 路径本地模拟成交并告警。

## 如何扩展

- **新数据源**：实现 `DataSource.fetchBars()`，在 `binanceSource.ts` 的 `createDataSource` 注册。
- **新策略**：实现 `Strategy.generate(ctx)`（可 async，可注入 LLM），在 `orchestrator.ts` 选择。
- **新 Agent**：继承 `Agent`，实现 `subscriptions()` 返回「Topic -> 处理方法」，在 `buildPipeline` 装配。
- **新券商**：实现 `Broker.submit(intent)`，订阅 `exec.order_intent`、广播 `exec.fill`。
- **新 LLM**：实现 `LLMClient.complete(prompt)`，在 `createLLMClient` 注册（非 OpenAI 兼容的本地模型亦可）。

## 设计取舍

- **同步事件总线**：回测/实盘同构、可复现；单标的、分钟级频率下性能足够。
- **TypeScript 严格模式 + `noUncheckedIndexedAccess`**：数组/映射访问显式判空，杜绝运行时 `undefined`。
- **密钥三不原则**：不进配置文件、不进日志、不进 API 响应（`redactConfig` 脱敏）。
- **零运行时重型依赖**：服务端仅 `express` / `js-yaml` / `dotenv`；图表为手写 SVG，无 UI 框架债。
