# 架构说明

## 分层

```
┌──────────────────────────────────────────────────────────────────┐
│ WebUI (React+Vite)      web/src/pages   7 个独立页面               │  界面
├──────────────────────────────────────────────────────────────────┤
│ Server                  src/server      REST + SSE + 配置/策略/对照控制器 │  接入层
├──────────────────────────────────────────────────────────────────┤
│ Agents                  src/agents      分析/策略/风控/装配          │  智能体
│ Strategies              src/strategies  动量 / LLM 决策              │
│ Risk                    src/risk        仓位与熔断规则               │
│ Portfolio               src/portfolio   记账、流水、权益曲线          │
│ Execution               src/execution   paper / exchange 券商       │
│ Backtest                src/backtest    多标的回测                   │
├──────────────────────────────────────────────────────────────────┤
│ Exchanges               src/exchanges   适配器 + 连接管理 + 密钥       │  数据/交易
│ Watchlist               src/watchlist   自选标的                      │
├──────────────────────────────────────────────────────────────────┤
│ Core                    src/core        事件总线 / 类型 / 日志        │  内核
└──────────────────────────────────────────────────────────────────┘
```

## 交易所适配层

`ExchangeAdapter` 是行情与交易的唯一抽象（`src/exchanges/types.ts`）：

```ts
interface ExchangeAdapter {
  meta: AdapterMeta;                       // 名称、品类、能力、密钥字段、周期
  init(cred): void;                         // 注入密钥与测试网开关
  testConnection(): Promise<ConnectionTest>;
  searchSymbols(q, limit?): Promise<SymbolInfo[]>;
  fetchTickers(symbols): Promise<Ticker[]>;
  fetchKlines(symbol, interval, limit): Promise<Bar[]>;
  placeOrder?(req): Promise<OrderResult>;   // 可选：仅支持交易的适配器实现
}
```

现有实现：模拟、Binance、Gate.io、OKX（加密货币），东方财富（A 股/港股）、Stooq（美股）。
新增交易所只需实现该接口并在 `registry.ts` 注册，UI 的目录、连接表单、周期下拉会自动出现。

**签名差异对照**（下单均走 HTTPS + 私有接口）：

| 交易所 | 算法 | 关键请求头 |
| --- | --- | --- |
| Binance | HMAC-SHA256(query) hex | `X-MBX-APIKEY` |
| Gate.io | HMAC-SHA512(body) hex | `KEY` / `Timestamp` / `SIGN` |
| OKX | HMAC-SHA256(ts+method+path+body) base64 | `OK-ACCESS-KEY` / `SIGN` / `TIMESTAMP` / `PASSPHRASE` |

**交易对写法差异**：Gate.io 用 `BTC_USDT`（下划线），Binance / OKX 用 `BTCUSDT`。
适配器在入口统一为「无下划线」展示，Gate 内部由 `toGatePair()` / `fromGatePair()` 转换。

**连接与密钥分离**：

- `Connection`（元信息）→ `data/connections.json`
- 密钥 → `data/secrets.json`（0600，`data/` 已在 `.gitignore`）
- `ConnectionView` 只暴露 `hasKey/hasSecret`，API 响应永远不含明文密钥

**实盘降级链**：`execution.mode=live` 且适配器 `supportsTrading` 且已配 Key → `ExchangeBroker`；
否则自动使用 `PaperBroker`，并在日志中告警、界面顶栏显示「模拟成交」。

## 通信约定

Agent 之间不允许直接引用对方实例（装配层除外），一律经 EventBus 广播：

| Topic | 载荷 | 生产者 | 消费者 |
| --- | --- | --- | --- |
| `market.bar` | `Bar` | `streamBars` / `LivePoller` | Analyst / Strategist / Portfolio |
| `agent.market_view` | `MarketView` | `MarketAnalystAgent` | `StrategistAgent` |
| `strategy.signal` | `Signal` | `StrategistAgent` | `RiskGuardAgent` |
| `exec.order_intent` | `OrderIntent` | `RiskGuardAgent` | Broker |
| `exec.order_rejected` | `Signal \| OrderIntent` | 各处 | 监控（预留） |
| `exec.fill` | `Fill` | Broker | `PortfolioManager` |

- `publish` 同步派发；`publishAsync` 顺序 await 每个处理器，流水线统一用后者保证顺序确定。
- Broker 在 `buildPipeline` 中订阅 `exec.order_intent`，成交后广播 `exec.fill`。

## 关键流程

**回测**：`runBacktest(config, {adapter, symbols, bars, interval, liveTrading})`
→ `buildPipeline` → 各标的并发拉 K 线 → `mergeBarsByTime` 归并为全局时间序列 → 逐根 `streamBars` → 汇总指标。

**实时**：`EngineController.start({mode:'live'})` → 拉 `bar_count` 根预热 → `LivePoller` 每 `poll_ms`
轮询各标的最新 2 根 K 线，仅广播新 K 线 → 刷新状态 → 回撤越限 `stop()`。
候选池行情不跟着轮询：只在启动与手动点「刷新」时取一次（`POST /api/tickers/refresh`）。

**多标的**：K 线先按 `timestamp` 全局排序再广播，因此组合层在同一时刻只看到一个标的一根 K 线，跨标的调仓顺序确定。

## 主题系统

- 所有颜色收敛为 CSS 变量，暗色与亮色各定义一套，仅切换 `:root` 上的变量；
- `web/src/lib/theme.ts` 的 `useTheme()` 负责：读 localStorage → 首次跟随 `prefers-color-scheme` → 写 `document.documentElement[data-theme]`；
- 主题状态不在 React 状态树之外单点维护，切换即时生效且与页面状态无关。

## WebUI 结构

```
web/src/
├── App.tsx                 # 壳：侧边导航 + 顶栏 + 页面路由（state 驱动，无路由库）
├── state/useAppStore.ts    # 全局状态：配置/行情/对照 + SSE + 连接/自选缓存 + Toast
├── api.ts                  # REST 客户端 + EventSource 订阅
├── pages/                  # dashboard / markets / exchanges / strategy / llm / risk / system
├── components/             # Shell / 图表 / 表格 / 事件流 / 运行控制 / UI 原子组件
└── lib/format.ts           # 金额、百分比、数量、时间的统一格式化
```

- 实时性靠 SSE：`state` 事件整体刷新，`event` 事件增量追加到事件流（保留最近 300 条）。
- 所有页面共享同一个 `useAppStore`，切换页面不丢状态、不重复请求。

## 安全与一致性

- **密钥三不原则**：不进配置文件、不进日志、不进 API 响应（`redactConfig` + `ConnectionView`）。
- **标记价一致性**：持仓浮盈用本次运行的 `prices`（PriceBook 快照），不用实时报价，
  避免回测时用现价与历史成本混算产生虚假盈亏。
- **类型严格**：`strict` + `noUncheckedIndexedAccess`，数组与字典访问显式判空。
- **随机但可复现**：模拟交易所的行情 = 固定的走向形状 + 每次重掷的随机噪声（同一代码不再每次长成固定的线），
  但价格是 `(情景种子, 走向名, 时刻)` 的纯函数 —— 同一情景内反复取数一致、历史不被改写，
  且结果里带种子，想核对某次结果可原样重跑。
- **自带走向的连接**：`AdapterMeta.builtinSymbols` 为真的交易所（模拟交易所）没有标的 ——
  它自带几条走向（`defaultSymbols` = 单边上行 / 缓慢阴跌 / 震荡整理 / 急速跳水 / 急涨急跌）。
  这些走向不进候选池，也不进候选池行情：价格是本地生成的，走向名不代表任何真实市场，
  列成行情只会让人以为真有一批标的在报价。
  这类连接在候选池 / 机器人 / 回测页都不出现「挑标的」这一步，运行目标直接取它的自带清单。

## 设计取舍

- **同步事件总线**：回测/实盘同构、可复现；分钟级、少量标的足够。高频场景可在 Broker 边界换异步实现，内核不动。
- **交易所内聚**：交易与行情都收敛到适配器，Agent 层完全不感知具体交易所。
- **零重型运行时依赖**：服务端仅 `express` / `js-yaml` / `dotenv`；图表为手写 SVG，无 UI 框架债。
- **零 CSS 框架**：样式为单一 CSS 文件 + 变量，亮暗两套主题不重复维护布局代码。
- **日志环形缓冲**：`core/logger` 保留最近 1000 条，`/api/logs` 供系统页查看，避免额外日志文件依赖。
- **趋势信号按噪声归一**：量化基线（双均线）的仓位不是「均线差 ×固定系数」—— 那个系数在波动大的品种上永远满仓、
  在 1m 这类安静周期上几乎永不建仓。现在的信号是趋势的 t 统计量（均线差 ÷ 它在纯噪声下的标准差，
  闭式解在 `strategies/momentum.ts`），随机游走上 z 标准差恰为 1；z<1 视为噪声不进场。
  同一套参数在 1m 与 1d、币和股上量纲一致。
- **多情景胜率**：单次回测的收益是一个随机数。「这套参数在多少比例的随机路径上盈利为正」
  （`validation/winRate.ts`，模拟交易所专用，同一起始种子可复现整份报告）把「大部分场景盈利」
  变成可测量的数字：winRate 看占比、median 看典型、worst 看最坏，费用已计入。
- **现金账户语义（模拟不提供融资）**：买入的钱只能来自账上现金。
  风控下单前按可用现金收缩买单（`risk/rules.ts` 的 `clampBuyToCash`，留 1% 给滑点与手续费），
  模拟券商在成交时做兜底：付不起全额就按付得起的量成交，零头都买不起才拒单
  （`execution/paperBroker.ts` 的 `availableCash`，广播 `ORDER_REJECTED`，事件流里能看到「现金不足」）。
  没有这道线时，多标的各自满仓（5 标的 × 50% = 2.5 倍总敞口）会把现金买成负数 ——
  等于模拟盘偷偷配资：大跌时权益能穿成负数，而真实现金账户里这些单根本下不出去。
  口径：现金 ≥ 0 恒成立 ⇒ 总敞口 ≤ 权益、权益 ≥ 0 ⇒ 收益率不可能 ≤ −100%。

## 如何扩展

- **新交易所**：实现 `ExchangeAdapter`，在 `registry.ts` 的 `createAdapter` 与 `listAdapterMetas` 注册。
- **新策略**：实现 `Strategy.generate(ctx)`（可 async、可注入 LLM），在 `orchestrator.ts` 选择。
- **新 Agent**：继承 `Agent`，实现 `subscriptions()`，在 `buildPipeline` 装配。
- **新页面**：`web/src/pages` 加文件，在 `App.tsx` 的 `NAV` 与 `render()` 中登记。