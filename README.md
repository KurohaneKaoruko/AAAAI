# AAAAI

**Ai - Agent - Auto - Asset - Investment** —— 基于多智能体（Multi-Agent）协作的自动化资产投研框架。

> 让多个 AI Agent 像一个投研团队一样分工协作：有人盯行情、有人做分析、有人定策略、有人管风险、有人下单记账，全程受控、可回放、可审计。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node-%3E%3D20-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)
![Status](https://img.shields.io/badge/status-WIP-orange)

## 项目简介

AAAAI 探索「LLM Agent × 量化投资」的自动化投研流程。一条事件驱动的 Agent 流水线贯穿全部环节：

```
行情数据 ─▶ 分析Agent ─▶ 策略Agent ─▶ 风控Agent ─▶ 执行(券商) ─▶ 组合记账
```

配套一个完整的 **WebUI 面板**：交易所连接、自选标的、策略、风控、LLM、日志各自独立成页，互不挤在一起。

## 功能一览

### 多交易所 · 多资产

| 交易所 | 品类 | 行情 | 下单 | 密钥 |
| --- | --- | --- | --- | --- |
| 模拟交易所 | 全品类 | 离线生成，每次一条新随机路径；标的自带、不用选 | 模拟成交 | 不需要 |
| Binance 币安 | 加密货币 | 公共接口 | HMAC-SHA256 签名下单 | 需要 |
| Gate.io | 加密货币 | 公共接口 | HMAC-SHA512 签名下单 | 需要 |
| OKX | 加密货币 | 公共接口 | OK-ACCESS 签名下单 | 需要 |
| 东方财富 | A 股 / 港股 / ETF | 实时 + K 线 | 仅行情（可模拟盘交易） | 不需要 |
| Stooq | 美股 | 日线 | 仅行情（可模拟盘交易） | 不需要 |

- 股票没有免费实盘接口，因此 A 股 / 美股连接默认 **真实行情 + 模拟成交**，策略照样能跑真实价格；
- 加密货币连接配好 Key 后可切「真实下单」，默认走测试网。

### 黑白双主题

- 顶栏一键切换暗色 / 亮色，选择持久化到浏览器本地；
- 首次访问跟随系统 `prefers-color-scheme`，之后以你的手动选择为准；
- 两套主题均为「纯黑 / 纯白」基调，全部颜色由 CSS 变量驱动，图表、表格、徽章、提示条全部适配。

### WebUI 面板（7 个独立页面）

| 页面 | 能做什么 |
| --- | --- |
| **仪表盘** | 运行控制（回测/实时）、6 项关键指标、权益曲线（悬停查看）、持仓/成交/事件三分页 |
| **自选标的** | 按连接搜索标的、查看现价涨跌、手动添加、移除；回测运行时按标的挑选 |
| **交易所连接** | 交易所目录（能力标签）、连接增删改、连通性测试、设为默认、密钥安全存储 |
| **策略** | 策略选择（动量 / LLM 决策）、均线窗口、目标仓位上限、Agent 流水线图、执行模式 |
| **风控** | 初始资金、手续费、滑点、单笔上限、仓位上限、回撤熔断，附每条规则的作用说明 |
| **LLM 大模型** | 开关、接口地址、模型、温度、决策节流、密钥环境变量、一键连通性测试 |
| **系统与日志** | 运行信息、配置写回文件、配置 JSON、服务端日志（按级别过滤） |

### 智能体流水线

- **可插拔接口**：`ExchangeAdapter` / `Strategy` / `Agent` / `Broker` 四类抽象，换实现即可扩展；
- **事件驱动内核**：同步派发 + 顺序 `publishAsync`，事件全量留痕（上限 5000）便于审计；
- **LLM 决策**：OpenAI 兼容客户端，按 `decision_interval` 节流调用，失败/超时/输出非法自动回退动量基线；
- **风控熔断**：权重上限、单笔金额截断、组合回撤熔断（实时模式触发自动停机）。

## 快速开始

```bash
# 1. 安装（Node >= 20）
npm install

# 2. 开发模式（后端 8787 + 前端 5173 热更新）
npm run dev
# 打开 http://localhost:5173

# 3. 生产模式：构建后单进程托管（WebUI 由 Express 提供）
npm run build
npm start
# 打开 http://localhost:8787
```

首次启动会自动创建一个「模拟交易所」连接，**开箱即用，无需任何密钥或外网**。模拟交易所的标的由它自带，不用选、也不进候选池。

### 测试与检查

```bash
npm test          # node:test 用例
npm run typecheck # 服务端 + WebUI 全量类型检查
```

## 接入真实行情

1. 进入 **交易所连接** 页 → 新建连接 → 选择 `Binance 币安`（或东财 / Stooq）→ 保存；
2. 进入 **自选标的** 页 → 选择该连接 → 搜索 `BTC` / `600519` / `AAPL` → 加入自选；
   （Gate.io 的 `BTC_USDT` 与其它家的 `BTCUSDT` 写法不同，搜索结果已统一成无下划线形式）
3. 进 **交易机器人** 页 → 新建机器人 → 选连接、选标的、选策略 → 「启动」。

### 实盘交易（高危）

```bash
# .env
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
```

在连接表单里填好 Key，并在 **风控页 → 执行方式** 切到「真实下单」。
机器人运行模式选「实时」时，只有在下列条件全部满足才会真的下单：执行方式=真实下单、连接支持交易、需要 Key 时已配置。**任一条不满足会直接拒绝启动并说明缺哪一条**（不会悄悄退回模拟）—— 用户以为钱打出去了实际没动，是最糟的结局。
**同一连接同时只允许一个实盘机器人**，避免并行下真单；机器人卡片会标出「实盘下单中」。
默认 `paper` 模拟成交。实盘有资金风险，请自行负责。

### 启用 LLM

```bash
# .env
OPENAI_API_KEY=...
```

在 **LLM 页** 打开开关并「测试连通性」。未配置 Key 时策略自动以纯规则模式运行，流水线不中断。

## 目录结构

```
AAAAI/
├── config/default.yaml     # 默认配置（WebUI 保存时写回）
├── data/                   # 运行时数据（已 gitignore）
│   ├── connections.json    #   交易所连接元信息
│   ├── secrets.json        #   API 密钥（0600）
│   └── watchlist.json      #   自选标的
├── src/
│   ├── core/               # 内核：类型 / 事件总线 / 日志环形缓冲
│   ├── exchanges/          # 交易所适配层
│   │   ├── types.ts        #   ExchangeAdapter 统一接口
│   │   ├── registry.ts     #   适配器注册与工厂
│   │   ├── connectionManager.ts # 连接 CRUD + 密钥保管
│   │   ├── simulated.ts / binance.ts / gate.ts / okx.ts / eastmoney.ts / stooq.ts
│   ├── agents/             # 智能体：analyst / strategist / riskGuard / orchestrator
│   ├── strategies/         # 策略：momentum / llmStrategy
│   ├── data/streaming.ts   # 价格簿、K 线归并、实时轮询
│   ├── risk/               # 风控规则
│   ├── portfolio/          # 组合记账（现金/持仓/权益曲线/流水）
│   ├── execution/          # 执行：paperBroker / exchangeBroker
│   ├── llm/                # LLM：协议 / OpenAI 兼容 / 空实现
│   ├── backtest/           # 回测引擎（多标的）
│   ├── server/             # HTTP API + SSE + 配置/策略/对照控制器
│   ├── watchlist.ts        # 自选管理
│   └── index.ts            # 入口
├── web/                    # WebUI（React + Vite）
│   └── src/{pages,components,state,lib}   # lib/theme.ts = 黑白主题切换
├── test/                   # node:test
└── docs/architecture.md    # 架构与扩展指南
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` `/api/config` `/api/logs` | 状态 / 配置 / 服务日志 |
| POST | `/api/config` `/api/config/persist` | 热更新 / 写回文件 |
| GET | `/api/exchanges` | 交易所目录 |
| GET/POST/PUT/DELETE | `/api/connections[/:id]` | 连接管理 |
| POST | `/api/connections/:id/test` | 连通性测试 |
| GET | `/api/markets/search` | 标的搜索 |
| GET/POST/DELETE | `/api/watchlist[/:id]` | 自选管理 |
| POST | `/api/llm/test` `/api/tickers/refresh` | LLM 测试 / 候选池行情刷新 |
| GET | `/api/events` | SSE：状态与事件流 |

## 免责声明

本项目仅用于**技术学习与研究**，不构成任何投资建议。市场有风险，据此操作，后果自负。

## License

[MIT](LICENSE) © KurohaneKaoruko