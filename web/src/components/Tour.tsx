/**
 * 新手引导（Tour）：一步一步在画面上指出「先做什么、再做什么」。
 *
 * 实现原则：
 * - 零依赖：遮罩层 position:fixed，用 4 块 div 拼出聚光洞（视口坐标系，
 *   目标坐标直接取 getBoundingClientRect，滚动/缩放/滚动条变化时重算）；
 * - 高亮框呼吸描边；气泡按目标位置在右/左/下/上自适应落点，宽度与高度
 *   都钳制在视口内，长文本内部滚动；
 * - 步骤可跨页面：每步可带 page（App 的 PageId），进入该步先导航，
 *   再轮询等待目标元素渲染出来（最多 2s）；
 * - 初次访问自动播放（localStorage 标记），顶栏「?」随时重看；
 * - 键盘：←/→ 切步、Esc 跳过。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
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
      "这是一套多智能体自动投研框架：机器人盯行情、AI 做分析、策略出信号、风控兜底、本地模拟成交记账。跟着这条路径走一遍，几分钟就能跑起第一台机器人。可点「跳过」，顶栏的 ? 按钮随时重看本指引。",
  },
  {
    target: "nav-exchanges",
    page: "exchanges",
    title: "第 1 步 · 连一个行情源并挑标的",
    body:
      "「交易所连接」里加一条连接：Binance / Gate / OKX 的公共行情无需密钥，想真实下单再填 Key；测试网只影响下单账户，K 线始终是主网真实数据。每个连接卡片下方就是「标的」：点开直接挑候选，AI/策略都在这里选资产。",
  },
  {
    target: "nav-strategy",
    page: "strategy",
    title: "第 2 步 · 攒好策略弹药",
    body:
      "「策略」页是机器人的弹药库：均线参数、仓位上限在这里调。自带默认策略即可开跑，不必先调参。要挑交易哪些标的，去「交易所连接」页 —— 每个连接卡片下方就能加。",
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
    body: "顶栏的 ? 按钮随时重看本指引。祝交易顺利：模拟成交先玩透，再上真金。",
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
  const [vp, setVp] = useState(() => ({
    w: document.documentElement.clientWidth,
    h: document.documentElement.clientHeight,
  }));
  const pollTimerRef = useRef(0);
  const schedTimerRef = useRef(0);
  // 气泡实际高度：内容长短不一，硬编码估算值会把气泡推出视口
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [bubbleH, setBubbleH] = useState(0);
  // onNavigate 用 ref 转发：父层若传内联函数，放进 effect 依赖会在每次渲染后重复导航
  const navRef = useRef(onNavigate);
  navRef.current = onNavigate;

  const isCentered = step.target === "welcome";

  const locate = useCallback(() => {
    // clientWidth/Height 不含滚动条：100vw 会把滚动条宽度也算进去，遮罩会撑出横向滚动
    setVp({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight });
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

  // 进入步骤：先清掉上一步的定位（否则气泡会按旧目标闪一帧），再导航（若跨页）
  useEffect(() => {
    setRect(null);
    if (step.page) navRef.current(step.page);
  }, [stepIndex, step.page]);

  useEffect(() => {
    let tries = 0;
    let stop = false;
    const tick = () => {
      if (stop) return;
      locate();
      const el = isCentered ? true : document.querySelector(`[data-tour="${step.target}"]`);
      if (!el && ++tries < 40) {
        // 50ms 一轮，最多等 2s。不用 rAF：后台标签页里 rAF 会被节流甚至暂停，
        // 跨页步骤会永远等不到目标（遮罩整屏、气泡卡在左上角）。
        pollTimerRef.current = window.setTimeout(tick, 50);
      }
    };
    // 先立即定位一次，正常页面无需等待
    tick();
    // 滚动/缩放都要重算：fixed 坐标跟着视口走
    const schedule = () => {
      window.clearTimeout(schedTimerRef.current);
      schedTimerRef.current = window.setTimeout(locate, 16);
    };
    window.addEventListener("scroll", schedule, true); // capture：内容区自身滚动也算
    window.addEventListener("resize", schedule);
    // 滚动条出现/消失只改变 clientWidth，不触发 resize —— ResizeObserver 兜住这种情况
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    ro?.observe(document.documentElement);
    return () => {
      stop = true;
      window.clearTimeout(pollTimerRef.current);
      window.clearTimeout(schedTimerRef.current);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      ro?.disconnect();
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
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  // 注：当前所有步骤目标都是 sticky 的侧栏/顶栏元素，不需要（也不应该）滚 window：
  // sticky 元素滚动时不移动，反而会把页面内容滚走。

  const pad = 6;
  // 聚光洞：仅限有真实目标的步骤。欢迎步不挖洞（整屏遮罩 + 气泡居中），
  // 否则会在页面中央露出莫名的一块内容，看起来像框错位。
  const hole = rect
    ? { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
    : null;

  // 气泡：宽钳制视口；欢迎步居中，其余优先目标右侧 → 左侧 → 下方 → 上方
  const bw = isCentered ? Math.min(420, vp.w - 24) : Math.min(360, vp.w - 24);
  // 实际高度未测量前给个保守估值，渲染后立刻校正
  const bh = bubbleH || 180;
  let bx = 12;
  let by = 12;
  if (!isCentered && hole) {
    bx = hole.left + hole.width + 16;
    by = hole.top;
    if (bx + bw > vp.w - 12) bx = hole.left - bw - 16;
    if (bx < 12) {
      // 左右都放不下：落到目标下方
      bx = 12;
      by = hole.top + hole.height + 16;
    }
    // 下方放不下就翻到目标上方；最后无论怎样都钳在视口内
    if (by + bh > vp.h - 12) by = hole.top - bh - 16;
    by = Math.max(12, Math.min(by, vp.h - bh - 12));
  }

  const bubbleStyle: CSSProperties = isCentered
    ? {
        // 居中用 transform，气泡高度随内容变化也不会偏
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        width: bw,
        maxHeight: vp.h - 24,
      }
    : { top: by, left: bx, width: bw, maxHeight: vp.h - 24 };

  // 测量气泡真实高度：内容换行/主题字体变化后校正落点，避免被推出视口
  useLayoutEffect(() => {
    const h = bubbleRef.current?.offsetHeight ?? 0;
    if (h > 0 && Math.abs(h - bubbleH) > 1) setBubbleH(h);
  });

  const isLast = stepIndex === steps.length - 1;

  return (
    <div className="tour-root">
      {hole ? (
        <>
          <div className="tour-mask" style={{ top: 0, left: 0, right: 0, height: Math.max(0, hole.top) }} />
          <div className="tour-mask" style={{ top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height }} />
          <div className="tour-mask" style={{ top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }} />
          <div className="tour-mask" style={{ top: hole.top + hole.height, left: 0, right: 0, height: Math.max(0, vp.h - hole.top - hole.height) }} />
          <div className="tour-spot" style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height }} />
        </>
      ) : (
        // 欢迎步，或目标尚未渲染出来：整屏遮罩，不挖洞。
        // 之前给欢迎步造了个「假洞」，页面中央会露出莫名一块内容，看着像框错位。
        <div className="tour-mask" style={{ inset: 0 }} />
      )}
      <div
        ref={bubbleRef}
        className="tour-bubble"
        style={bubbleStyle}
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
