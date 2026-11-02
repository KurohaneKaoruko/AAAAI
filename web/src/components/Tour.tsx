/**
 * 新手引导（Tour）：一步一步在画面上指出「先做什么、再做什么」。
 *
 * 实现原则：
 * - 零依赖：遮罩用 4 块 div 拼出聚光洞，高亮框呼吸描边，
 *   气泡按目标位置在四周自动挑落点；
 * - 步骤可跨页面：每步可带 page（App 的 PageId），进入该步先导航，
 *   再轮询等待目标元素渲染出来（最多 2s）；
 * - 初次访问自动播放（localStorage 标记），顶栏「?」随时重看；
 * - 键盘：←/→ 切步、Esc 跳过；resize 重算位置。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PageId } from "./Shell";
import { Button } from "./ui";

/** 一条引导步骤 */
export interface TourStep {
  /** 目标元素的 data-tour 值；welcome / tour-restart 两步无目标（居中卡片） */
  target: string;
  title: string;
  body: string;
  /** 该步骤所在页面：进入步骤前先导航 */
  page?: PageId;
}

/** 推荐上手路径：连行情 → 攒策略弹药 → 开机器人 → 看盘复盘 → 风控兜底。 */
export const TOUR_STEPS: TourStep[] = [
  {
    target: "welcome",
    page: "dashboard",
    title: "欢迎使用 AAAAI",
    body:
      "这是一套多智能体自动投研框架：机器人盯行情、AI 做分析、策略出信号、风控兜底、模拟盘记账。跟着这条路径走一遍，几分钟就能跑起第一台机器人。可点「跳过」，顶栏的 ? 按钮随时重看本指引。",
  },
  {
    target: "nav-exchanges",
    page: "exchanges",
    title: "第 1 步 · 连一个行情源",
    body:
      "「交易所连接」里加一条连接：模拟交易所零配置可直接跑；Binance / Gate / OKX 的公共行情无需密钥，想真实下单再填 Key（默认测试网）。连好后这里会显示连通状态。",
  },
  {
    target: "nav-strategy",
    page: "strategy",
    title: "第 2 步 · 攒好策略弹药",
    body:
      "「策略」页是机器人的弹药库：均线参数、仓位上限在这里调；「候选池」标签里挑好关注的标的，机器人开局直接从池子里选。自带默认策略即可开跑，不必先调参。",
  },
  {
    target: "nav-bots",
    page: "bots",
    title: "第 3 步 · 创建你的机器人",
    body:
      "「交易机器人」→ 创建：选连接与标的、均线窗口、初始资金；决策来源可选纯量化规则或大模型参与。默认模拟成交（paperTrading），不动真金。",
  },
  {
    target: "nav-dashboard",
    page: "dashboard",
    title: "第 4 步 · 仪表盘看全局",
    body:
      "仪表盘汇总所有机器人：总权益、本次盈亏、权益曲线、持仓与成交流水。顶栏账户条与侧栏底部的活性灯告诉你数据是否实时——绿点呼吸 = SSE 通道在线。",
  },
  {
    target: "nav-compare",
    page: "compare",
    title: "第 5 步 · 同场比一比",
    body:
      "「模拟对照」让机器人、量化策略、大模型跑同一份行情，同坐标系权益对比 + 战绩排行；「历史模拟」拿历史 K 线先验一验，再决定要不要上实盘。",
  },
  {
    target: "nav-risk",
    page: "risk",
    title: "第 6 步 · 风控兜底",
    body:
      "单笔上限、仓位上限、回撤熔断都在这里。执行方式默认模拟成交；切「真实下单」会有二次确认——那是全站最危险的一个开关。",
  },
  {
    target: "tour-restart",
    page: "dashboard",
    title: "最后 · 迷路了就回这里",
    body: "顶栏的 ? 按钮随时重看本指引。祝交易顺利：模拟盘先玩透，再上真金。",
  },
];

const SEEN_KEY = "aaaai.tour.seen";

export function shouldShowTourOnFirstVisit(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) !== "1";
  } catch {
    return false;
  }
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** 挂在 App 里的总入口：首访自动播；父层递增 forceKey 手动重播。 */
export function Tour({
  onNavigate,
  forceKey = 0,
}: {
  onNavigate: (p: PageId) => void;
  forceKey?: number;
}) {
  const [active, setActive] = useState(shouldShowTourOnFirstVisit);
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (forceKey > 0) {
      setStepIndex(0);
      setActive(true);
    }
  }, [forceKey]);

  const close = useCallback(() => {
    try {
      window.localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* 隐私模式下写不进就算了 */
    }
    setActive(false);
  }, []);

  if (!active) return null;
  return (
    <TourOverlay
      stepIndex={stepIndex}
      onStep={setStepIndex}
      onNavigate={onNavigate}
      onClose={close}
    />
  );
}

/** 遮罩 + 高亮 + 气泡主体。 */
function TourOverlay({
  stepIndex,
  onStep,
  onNavigate,
  onClose,
}: {
  stepIndex: number;
  onStep: (i: number) => void;
  onNavigate: (p: PageId) => void;
  onClose: () => void;
}) {
  const steps = TOUR_STEPS;
  const step = steps[Math.min(stepIndex, steps.length - 1)];
  const [rect, setRect] = useState<Rect | null>(null);
  const [doc, setDoc] = useState({ w: 0, h: 0 });
  const rafRef = useRef(0);

  const isCentered = step.target === "welcome" || step.target === "tour-restart";

  const locate = useCallback(() => {
    const el = isCentered
      ? null
      : document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    if (el) {
      const r = el.getBoundingClientRect();
      setRect({ top: r.top + window.scrollY, left: r.left + window.scrollX, width: r.width, height: r.height });
    } else if (!isCentered) {
      setRect(null); // 还没渲染出来：先不画高亮，等下一帧
    }
    setDoc({ w: window.innerWidth, h: document.documentElement.scrollHeight });
  }, [step.target, isCentered]);

  // 进入步骤：先导航（若跨页），再轮询等目标元素出现
  useEffect(() => {
    if (step.page) onNavigate(step.page);
  }, [stepIndex, step.page, onNavigate]);

  useEffect(() => {
    let tries = 0;
    const tick = () => {
      locate();
      const found = isCentered || document.querySelector(`[data-tour="${step.target}"]`);
      if (!found && ++tries < 120) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    const onResize = () => locate();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
    };
  }, [locate, step.target, isCentered]);

  // 键盘：←/→ 步进、Esc 跳过
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  const go = (dir: 1 | -1) => {
    const next = stepIndex + dir;
    if (next < 0) return;
    if (next >= steps.length) {
      onClose();
      return;
    }
    onStep(next);
  };

  // 目标滚进视野
  useLayoutEffect(() => {
    if (!rect || isCentered) return;
    const top = rect.top - window.scrollY;
    if (top < 0 || top > window.innerHeight - 80) {
      window.scrollTo({ top: Math.max(0, rect.top - window.innerHeight / 3), behavior: "smooth" });
    }
  }, [rect, stepIndex, isCentered]);

  const vw = doc.w || window.innerWidth;
  const pad = 6;
  const hole = rect
    ? { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
    : isCentered
      ? { top: Math.max(80, doc.h / 2 - 60), left: vw / 2 - 240, width: 480, height: 120 }
      : null;

  // 气泡落点：优先目标右侧 → 左侧 → 下方 → 上方
  const bw = 360;
  const bh = 190;
  let bx = 12;
  let by = 12;
  if (hole) {
    bx = hole.left + hole.width + 16;
    by = hole.top;
    if (bx + bw > vw - 12) bx = hole.left - bw - 16;
    if (bx < 12) {
      bx = Math.min(Math.max(12, hole.left), Math.max(12, vw - bw - 12));
      by = hole.top + hole.height + 16;
    }
    if (by + bh > doc.h - 12) by = Math.max(12, hole.top - bh - 16);
    if (by < 12) by = 12;
  }

  const isLast = stepIndex === steps.length - 1;

  return (
    <div className="tour-root">
      {hole && (
        <>
          <div className="tour-mask" style={{ top: 0, left: 0, width: "100%", height: Math.max(0, hole.top) }} />
          <div className="tour-mask" style={{ top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height }} />
          <div
            className="tour-mask"
            style={{ top: hole.top, left: hole.left + hole.width, width: Math.max(0, vw - hole.left - hole.width), height: hole.height }}
          />
          <div
            className="tour-mask"
            style={{ top: hole.top + hole.height, left: 0, width: "100%", height: Math.max(0, doc.h - hole.top - hole.height) }}
          />
          <div className="tour-spot" style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height }} />
        </>
      )}
      <div className="tour-bubble" style={{ top: by, left: bx, width: bw }} role="dialog" aria-label={step.title}>
        <div className="tour-step">
          {stepIndex + 1} / {steps.length}
        </div>
        <div className="tour-title">{step.title}</div>
        <div className="tour-body">{step.body}</div>
        <div className="tour-actions">
          <Button variant="ghost" onClick={onClose}>
            跳过
          </Button>
          <div style={{ flex: 1 }} />
          {stepIndex > 0 && (
            <Button variant="ghost" onClick={() => go(-1)}>
              ← 上一步
            </Button>
          )}
          <Button variant="primary" onClick={() => go(1)}>
            {isLast ? "完成" : "下一步 →"}
          </Button>
        </div>
      </div>
    </div>
  );
}
