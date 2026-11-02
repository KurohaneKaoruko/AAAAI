/**
 * 新手引导（Tour）：一步一步在画面上指出「先做什么、再做什么」。
 *
 * 实现原则：
 * - 零依赖：遮罩层 position:fixed，用 4 块 div 拼出聚光洞（视口坐标系，
 *   目标坐标直接取 getBoundingClientRect，滚动/缩放时 rAF 重算）；
 * - 高亮框呼吸描边；气泡按目标位置在右/左/下/上自适应落点，宽度与高度
 *   都钳制在视口内，长文本内部滚动；
 * - 步骤可跨页面：每步可带 page（App 的 PageId），进入该步先导航，
 *   再轮询等待目标元素渲染出来（最多 2s）；
 * - 初次访问自动播放（localStorage 标记），顶栏「?」随时重看；
 * - 键盘：←/→ 切步、Esc 跳过。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PageId } from "./Shell";
import { Button } from "./ui";

/** 一条引导步骤 */
export interface TourStep {
  /** 目标元素的 data-tour 值；welcome 步无目标（视口居中卡片） */
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

/** 视口坐标系里的一个矩形 */
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
  return <TourOverlay stepIndex={stepIndex} onStep={setStepIndex} onNavigate={onNavigate} onClose={close} />;
}

/** 遮罩 + 高亮 + 气泡主体（全部 fixed / 视口坐标）。 */
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
  /** 目标在视口内的矩形；null = 元素尚未渲染或本步无目标 */
  const [rect, setRect] = useState<Rect | null>(null);
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  const rafRef = useRef(0);
  // onNavigate 用 ref 转发：父层若传内联函数，放进 effect 依赖会在每次渲染后重复导航
  const navRef = useRef(onNavigate);
  navRef.current = onNavigate;

  const isCentered = step.target === "welcome";

  const locate = useCallback(() => {
    setVp({ w: window.innerWidth, h: window.innerHeight });
    if (isCentered) {
      setRect(null); // 欢迎步没有目标元素，气泡自己居中
      return;
    }
    const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    if (el) {
      const r = el.getBoundingClientRect(); // 视口坐标，滚动后重算即同步
      if (r.width > 0 && r.height > 0) {
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
        return;
      }
    }
    setRect(null);
  }, [step.target, isCentered]);

  // 进入步骤：先导航（若跨页），再轮询等目标元素出现
  useEffect(() => {
    if (step.page) navRef.current(step.page);
  }, [stepIndex, step.page]);

  useEffect(() => {
    let tries = 0;
    let stop = false;
    const tick = () => {
      if (stop) return;
      locate();
      const el = isCentered ? true : document.querySelector(`[data-tour="${step.target}"]`);
      if (!el && ++tries < 120) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    // 滚动/缩放都要重算：fixed 坐标跟着视口走
    const schedule = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(locate);
    };
    window.addEventListener("scroll", schedule, true); // capture：内容区自身滚动也算
    window.addEventListener("resize", schedule);
    return () => {
      stop = true;
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [locate, step.target, isCentered]);

  const go = useCallback(
    (dir: 1 | -1) => {
      const next = stepIndex + dir;
      if (next < 0) return;
      if (next >= steps.length) {
        onClose();
        return;
      }
      onStep(next);
    },
    [stepIndex, steps.length, onClose, onStep],
  );

  // 键盘：←/→ 步进、Esc 跳过
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  // 目标滚进视野（fixed 坐标直接判断，比 scrollY 换算直观）
  useLayoutEffect(() => {
    if (!rect) return;
    const bottom = rect.top + rect.height;
    if (rect.top < 0 || rect.top > vp.h - 60 || bottom > vp.h) {
      const delta = rect.top - vp.h / 3;
      window.scrollBy({ top: delta, behavior: "smooth" });
    }
  }, [rect, stepIndex, vp.h]);

  const pad = 6;
  // 聚光洞：有目标用目标外扩；欢迎步在视口中央开一个假想洞（只用于摆气泡）
  const hole = rect
    ? { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
    : isCentered
      ? { top: vp.h / 2 - 70, left: vp.w / 2 - 200, width: 400, height: 140 }
      : null;

  // 气泡：宽/高钳制视口；落点优先目标右侧 → 左侧 → 下方 → 上方
  const bw = Math.min(360, vp.w - 24);
  const bhEst = 200;
  let bx: number;
  let by: number;
  if (isCentered) {
    // 欢迎步：气泡盖在假想洞正下方居中
    bx = Math.max(12, Math.min(vp.w / 2 - bw / 2, vp.w - bw - 12));
    by = hole ? Math.min(hole.top + hole.height + 16, vp.h - bhEst - 12) : 12;
    if (by < 12) by = Math.max(12, vp.h / 2 - bhEst / 2);
  } else if (hole) {
    bx = hole.left + hole.width + 16;
    by = hole.top;
    if (bx + bw > vp.w - 12) bx = hole.left - bw - 16;
    if (bx < 12) {
      bx = Math.max(12, Math.min(hole.left, vp.w - bw - 12));
      by = hole.top + hole.height + 16;
    }
    if (by + bhEst > vp.h - 12) by = Math.max(12, hole.top - bhEst - 16);
  } else {
    // 目标还没渲染出来：先停在左上角，等定位到再跳过去
    bx = 12;
    by = 12;
  }

  const isLast = stepIndex === steps.length - 1;

  return (
    <div className="tour-root">
      {hole && (
        <>
          <div className="tour-mask" style={{ top: 0, left: 0, width: "100vw", height: Math.max(0, hole.top) }} />
          <div className="tour-mask" style={{ top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height }} />
          <div
            className="tour-mask"
            style={{ top: hole.top, left: hole.left + hole.width, width: Math.max(0, vp.w - hole.left - hole.width), height: hole.height }}
          />
          <div
            className="tour-mask"
            style={{ top: hole.top + hole.height, left: 0, width: "100vw", height: Math.max(0, vp.h - hole.top - hole.height) }}
          />
          {!isCentered && (
            <div className="tour-spot" style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height }} />
          )}
        </>
      )}
      <div
        className="tour-bubble"
        style={{ top: by, left: bx, width: bw, maxHeight: vp.h - 24 }}
        role="dialog"
        aria-label={step.title}
      >
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
