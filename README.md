# AAAAI

**Ai - Agent - Auto - Asset - Investment** —— 基于多智能体（Multi-Agent）协作的自动化资产投研框架。

> 让多个 AI Agent 像一个投研团队一样分工协作：有人盯行情、有人做分析、有人定策略、有人管风险、有人下单记账，全程受控、可回放、可审计。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node-%3E%3D20-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)
![Status](https://img.shields.io/badge/status-WIP-orange)

## 项目简介

AAAAAI 探索「LLM Agent × 量化投资」的自动化投研流程。系统由一条事件驱动的 Agent 流水线构成：

```
行情数据 ─▶ 分析Agent ─▶ 策略Agent ─▶ 风控Agent ─▶ 执行(券商) ─▶ 组合记账
```

每个环节都是可替换组件，Agent 之间只通过事件总线（EventBus）通信，互不直接调用。内置 **WebUI 看板**，实时观察权益曲线、持仓、事件流，并可在线操控引擎。

## 核心特性

- **多 Agent 流水线**：`MarketAnalyst → Strategist → RiskGuard → Broker → Portfolio`
- **事件驱动内核**：同步派发 + 全量留痕，回测与实盘共用同一条流水线
- **可插拔接口**：`DataSource` / `Strategy` / `Agent` / `Broker` 四类抽象，替换实现即可扩展
- **两种数据源**：`stub`（内置确定性假数据，零依赖）与 `binance`（币安真实公共行情）
- **两种券商**：`paper`（模拟成交）与 `binance`（HMAC 签名实盘网关，默认 dryRun + 测试网）
- **LLM 决策**：OpenAI 兼容客户端，`llm-momentum` 策略由 LLM 拍仓位、动量基线兜底，可整体退化为纯规则
- **风控熔断**：权重上限、单笔金额上限、组合回撤熔断（live 模式触发即自动停机）
- **WebUI 看板**：React + Vite，SSE 实时推送，权益曲线/持仓/事件流/参数配置/引擎控制

## 快速开始

```bash
# 1. 安装（Node >= 20）
npm install

# 2. 一键开发（后端 8787 + 前端 5173 热更新）
npm run dev
# 打开 http://localhost:5173

# 3. 或者生产模式：构建后单进程服务（WebUI 由 Express 托管）
npm run build
npm start
# 打开 http://localhost:8787
```

服务启动后会自动跑一次 stub 回测，WebUI 打开即有数据；`AAAAI_AUTOSTART=0` 可关闭。

### 测试与检查

```bash
npm test          # node:test 单元/集成测试
npm run typecheck # TS 全量类型检查（服务端 + WebUI）
```

## 使用指南

### 启用 LLM 决策

```bash
cp .env.example .env
# 编辑 .env 填入 OPENAI_API_KEY
# config/default.yaml: llm.enabled = true
```

LLM 策略按 `llm.decision_interval` 节流调用（默认每 10 根 K 线一次）；无 Key / 请求失败 / 输出非法时自动回退动量基线，流水线不中断。

### 接入真实行情

`config/default.yaml` 中 `market.source: binance`，`symbols: [BTCUSDT]` 按需改（币安现货代码，如 `ETHUSDT`）。回测与实时模式都会走真实 K 线。

### 实盘交易（高危）

```yaml
execution:
  broker: binance
  dry_run: false            # 只有这一行改成 false 才会真实下单
  base_url: https://testnet.binance.vision   # 默认测试网；主网改为 https://api.binance.com
```

并在 `.env` 配置 `BINANCE_API_KEY` / `BINANCE_API_SECRET`。**默认 dryRun=true，任何配置缺失都会自动降级为模拟模式。实盘有资金风险，请自行负责。**

## 目录结构

```
AAAAI/
├── config/default.yaml     # 全局配置（行情/LLM/策略/风控/执行）
├── src/
│   ├── index.ts            # 服务入口（装配 + 启动 HTTP + 自动回测）
│   ├── config.ts           # YAML 加载 + 安全取值工具
│   ├── configSchema.ts     # 类型化配置 + 默认值 + 脱敏
│   ├── core/               # 内核：types / eventBus / logger
│   ├── agents/             # 智能体：analyst / strategist / riskGuard / orchestrator
│   ├── strategies/         # 策略：momentum / llmStrategy
│   ├── data/               # 数据：stubSource / binanceSource / marketDataService
│   ├── risk/               # 风控规则
│   ├── portfolio/          # 组合管理（现金/持仓/权益曲线）
│   ├── execution/          # 执行：paperBroker / binanceBroker
│   ├── llm/                # LLM：llmClient / openaiClient / nullClient
│   ├── backtest/           # 回测引擎
│   └── server/             # HTTP API + SSE + 引擎控制器
├── web/                    # WebUI（React + Vite）
│   └── src/components/     # 看板/图表/持仓/事件流/控制台/参数面板
├── test/                   # node:test 测试
└── docs/architecture.md    # 架构与扩展指南
```

## 工作原理（一次 BAR 的生命周期）

1. `fetchBars` 从数据源取 K 线，`streamBars` 逐根广播 `market.bar`；
2. `MarketAnalystAgent` 维护快/慢均线，产出 `agent.market_view`（可选 LLM 点评）；
3. `StrategistAgent` 调用可插拔 `Strategy`（`llm-momentum` 或 `momentum`），产出 `strategy.signal`；
4. `RiskGuardAgent` 按 `RiskRules` 校验（权重/回撤熔断），通过则折算为 `exec.order_intent`；
5. `PaperBroker` / `BinanceBroker` 成交并广播 `exec.fill`；
6. `PortfolioManager` 更新现金与持仓，记录权益曲线；回撤越限时 live 模式自动停机。

## 开发路线图

- [x] 事件驱动内核与领域模型
- [x] 多 Agent 流水线（分析/策略/风控/执行/记账）
- [x] 双数据源（stub / Binance）与双券商（paper / Binance+dryRun）
- [x] LLM 决策接入（OpenAI 兼容，带节流与兜底）
- [x] WebUI 看板（SSE 实时 + 引擎控制 + 参数配置）
- [ ] 更多策略与参数寻优
- [ ] 多标的组合级风控
- [ ] 监控告警与持久化
- [ ] WebUI 增加回测对比与报告导出

## 免责声明

本项目仅用于**技术学习与研究**，不构成任何投资建议。市场有风险，据此操作，后果自负。

## License

[MIT](LICENSE) © KurohaneKaoruko
