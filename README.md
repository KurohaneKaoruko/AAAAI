# AAAAI

**Ai - Agent - Auto - Asset - Investment** —— 基于多智能体协作的自动化资产投研框架。

> 让多个 AI Agent 像一个投研团队一样分工协作：有人盯行情、有人做分析、有人定策略、有人管风险，全程受控、可回放、可审计。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-skeleton-orange)

## 项目简介

AAAAI 探索「LLM Agent × 量化投资」的自动化投研流程。系统规划由一条事件驱动的 Agent 流水线构成：

```
行情数据 ─▶ 分析Agent ─▶ 策略Agent ─▶ 风控Agent ─▶ 执行(券商) ─▶ 组合记账
```

每个环节都将是可替换的组件，Agent 之间只通过事件总线（EventBus）通信，互不直接调用。
当前仓库为**骨架（skeleton）版本**，仅包含项目基础设施，代码实现尚未开始。

## 当前内容

| 文件 | 说明 |
| --- | --- |
| `README.md` | 本文件 |
| `LICENSE` | MIT 许可证 |
| `.gitignore` | Git 排除规则（Python 产物 / 密钥 / 环境等） |
| `.env.example` | 环境变量模板（密钥只进环境变量，不入库） |
| `config/default.yaml` | 全局配置模板（策略 / 风控 / 执行参数） |

## 快速开始

```bash
git clone git@github.com:KurohaneKaoruko/AAAAI.git
cd AAAAI
cp .env.example .env   # 填写自己的密钥，.env 已被 .gitignore 忽略
```

## 开发路线图

- [x] 项目基础设施（README / 许可证 / Git 排除 / 配置模板）
- [ ] 项目骨架与事件驱动内核
- [ ] 多 Agent 流水线（分析 / 策略 / 风控 / 执行 / 记账）
- [ ] 真实行情数据源（交易所 / 财经 API 适配器）
- [ ] LLM 决策 Agent（接入本地或云端大模型）
- [ ] Paper Broker、回测引擎与监控告警

## 免责声明

本项目仅用于**技术学习与研究**，不构成任何投资建议。市场有风险，据此操作，后果自负。

## License

[MIT](LICENSE) © KurohaneKaoruko
