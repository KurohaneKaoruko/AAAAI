/**
 * 模拟对照：同一份行情、同一套风控、同一笔初始资金，多个选手各自独立操盘，
 * 横向比"谁的决策更赚钱"。选手可以是：
 * - 配置好的机器人（它用什么策略/模型就用什么）
 * - 策略列表里的任何一条（比策略参数）
 * - 模型实例（比模型，沿用默认策略参数）
 * - 动量基线（不调模型的参照系）
 *
 * 参赛者清单来自服务端（/api/bench/participants）：能勾哪些、为什么不能勾，
 * 以服务端为准 —— 前端自己猜会出现"勾了却跑不了"。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { AppStore } from "../state/useAppStore";
import type { ComparisonResult, EngineState, Participant, RunnerResult } from "../types";
import { Button, Empty, Notice, NumberField, Panel, SelectField } from "../components/ui";
import { Badge } from "../components/ui";
import { money, pct, signed, signedPct, time } from "../lib/format";

const PALETTE = ["#4f8ef7", "#2fbf82", "#e3a53c", "#c699f0", "#f0554b", "#57b6c9", "#a06ef7", "#94a3b8"];

const TYPE_LABEL: Record<Participant["type"], string> = {
  baseline: "基线",
  bot: "机器人",
  strategy: "策略",
  model: "模型",
};

const SOURCE_LABEL: Record<string, string> = {
  rules: "量化交易",
  chat: "对话模型",
  systemone: "决策模型",
  hybrid: "混合决策",
};

const MAX_RUNNERS = 6;

export function ComparePage({ store, onNavigate }: { store: AppStore; onNavigate?: (target: "llm" | "pool") => void }) {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<ComparisonResult | null>(store.state?.comparison ?? null);
  /** 多轮压力测试：每轮一条新的随机路径，单轮名次不再被当成结论 */
  const [series, setSeries] = useState<ComparisonResult[]>([]);
  const [rounds, setRounds] = useState(3);
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bars, setBars] = useState(store.state?.config?.market?.barCount ?? 200);
  /** 对照连接：默认跟全局一致，但允许在这里换（机器人连不同交易所时尤其重要） */
  const [connectionId, setConnectionId] = useState(store.state?.runTarget?.connectionId ?? "");
  const [target, setTarget] = useState<EngineState["runTarget"] | null>(store.state?.runTarget ?? null);
  /** 情景种子：留空 = 掷一条新路径；填数字 = 沿用那一条（复现） */
  const [seedText, setSeedText] = useState("");
  const [loaded, setLoaded] = useState(false);

  const loadParticipants = useCallback(async (cid: string) => {
    setLoaded(false);
    try {
      const d = await api.participants(cid);
      setParticipants(d.participants);
      setTarget(d.target);
      // 默认勾上：基线 + 所有可参赛者（上限内）；换连接后按新连接的可用性重选
      const runnable = d.participants.filter((p) => !p.unavailable && p.type !== "baseline").map((p) => p.key);
      const withBaseline = d.participants.some((p) => p.type === "baseline" && !p.unavailable) ? ["baseline"] : [];
      setPicked(new Set([...withBaseline, ...runnable].slice(0, MAX_RUNNERS)));
    } catch (err) {
      setError((err as Error).message);
      setParticipants([]);
      setPicked(new Set());
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!connectionId && store.state?.runTarget?.connectionId) {
      setConnectionId(store.state.runTarget.connectionId);
    }
  }, [store.state?.runTarget?.connectionId, connectionId]);

  useEffect(() => {
    if (connectionId) void loadParticipants(connectionId);
  }, [connectionId, loadParticipants]);

  /** 对照标的以服务端解析的 target 为准（它按连接过滤过） */
  const targetError = target?.error ?? null;
  const symbols = target?.symbols ?? [];
  /** 跑在随机行情上：此时"每次结果都不同"要说清楚，否则像 bug */
  const simulatedTarget = target?.marketData === "simulated";
  const futuresTarget = target?.tradingMode === "futures";

  // 非法种子宁可不认也不假装在复现（服务端也是这个口径）：界面必须说出来，
  // 否则用户填了个错的种子、以为在复现某次名次，其实跑的是另一条路。
  const seedInput = seedText.trim();
  const seedOk = seedInput === "" || (Number.isInteger(Number(seedInput)) && Number(seedInput) >= 0);

  const decisionInterval = Math.max(1, store.state?.config?.llm?.decisionInterval ?? 10);
  const modelRunners = participants.filter(
    (p) => picked.has(p.key) && !p.unavailable && p.decisionSource !== "rules",
  ).length;
  const estimatedCalls = Math.floor(bars / decisionInterval) * modelRunners * (simulatedTarget ? Math.max(1, rounds) : 1);
  /** 真实行情只有一条历史，跑多轮也是同一个数；所以只在随机行情上允许多轮 */
  const effectiveRounds = simulatedTarget ? Math.max(1, Math.min(20, Math.round(rounds))) : 1;

  const blocked = useMemo(() => {
    if (!loaded) return "正在读取参赛者…";
    if (!connectionId) return "还没有选择对照连接";
    if (targetError) return targetError;
    if (participants.length === 0) return "还没有可参赛的东西：添加机器人、策略或模型都能参赛";
    if (picked.size === 0) return "还没有勾选参赛者";
    return null;
  }, [loaded, connectionId, targetError, participants.length, picked.size]);

  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        if (next.size >= MAX_RUNNERS) {
          store.toast("error", `一次最多 ${MAX_RUNNERS} 个参赛者（并行跑，时间线性变长）`);
          return prev;
        }
        next.add(key);
      }
      return next;
    });

  const run = useCallback(async () => {
    if (blocked) return;
    setBusy(true);
    setError(null);
    setSeries([]);
    const seed =
      seedInput !== "" && Number.isInteger(Number(seedInput)) && Number(seedInput) >= 0
        ? Number(seedInput)
        : undefined;
    const runs: ComparisonResult[] = [];
    try {
      for (let i = 0; i < effectiveRounds; i += 1) {
        setProgress(effectiveRounds > 1 ? `第 ${i + 1} / ${effectiveRounds} 轮` : "");
        const r = await api.runComparison({
          keys: [...picked],
          connectionId,
          bars,
          // 种子非法就当没填：宁可在新路径上跑，也不要假装在复现。
          // 多轮时以用户给的种子为起点逐轮 +1，保证整组实验可复现。
          ...(seed !== undefined ? { scenarioSeed: (seed + i) >>> 0 } : {}),
        });
        runs.push(r.result);
        setResult(r.result);
        setSeries([...runs]);
      }
      const last = runs[runs.length - 1];
      const top = last?.results.find((x) => x.id === last.winners[0]);
      const suffix = runs.length > 1 ? `${runs.length} 轮完成，最后一轮` : "对照完成";
      store.toast("success", `${suffix}：${top?.label ?? "无"} 领先（${pct(top?.totalReturn ?? 0)}）`);
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      store.toast("error", msg);
    } finally {
      setBusy(false);
      setProgress("");
    }
  }, [blocked, picked, bars, connectionId, effectiveRounds, seedInput, store]);

  const ranked = useMemo(
    () => (result ? [...result.results].filter((r) => r.ok).sort((a, b) => b.totalReturn - a.totalReturn) : []),
    [result],
  );
  const aggregates = useMemo(() => (series.length > 1 ? aggregateRounds(series) : []), [series]);

  const groups: { type: Participant["type"]; title: string; hint: string }[] = [
    { type: "bot", title: "机器人", hint: "直接拿配置好的机器人上场：它引用哪条策略、哪些模型，就按那套跑" },
    { type: "strategy", title: "量化策略与决策策略", hint: "策略列表里的每一条都能单独上场 —— 比的就是这些参数" },
    { type: "model", title: "模型实例", hint: "沿用默认策略的参数，只换「谁来做决策」" },
    { type: "baseline", title: "参照系", hint: "同样的参数但不调模型 —— 有了它才知道模型是不是真比规则强" },
  ];

  return (
    <div className="page page-compare">
      <Panel
        title="模拟对照"
        subtitle="同一份行情、同一套风控、同一笔初始资金 —— 机器人、量化策略、模型同场竞技，比「谁更会赚钱」"
        actions={
          <Button variant="primary" onClick={() => void run()} busy={busy} disabled={blocked !== null}>
            {busy ? progress || "对照中…" : result ? "重新对照" : "开始对照"}
          </Button>
        }
      >
        {/* 一句话说清"点了会发生什么"，以及为什么现在点不了 */}
        <div className={`compare-status ${blocked ? "compare-blocked" : "compare-ready"}`}>
          {blocked ? (
            <>
              <span className="compare-status-lead">还不能开始：</span>
              {blocked}
              {targetError && targetError.includes("候选池") && onNavigate && (
                <Button small onClick={() => onNavigate("pool")}>
                  去候选池 →
                </Button>
              )}
            </>
          ) : (
            <>
              <span className="compare-status-lead">可以开始：</span>
              {picked.size} 个参赛者 · {symbols.length} 个{target?.symbolsBuiltIn ? "走向" : "标的"}（{target?.connectionLabel}）
              {target?.tradingMode === "futures" ? " · 合约模式" : ""} · {bars} 根/标的
              {effectiveRounds > 1 ? ` · ${effectiveRounds} 轮随机行情` : ""}
              {modelRunners > 0 && (
                <>
                  {" "}
                  · 预计 <b className="mono">≈{estimatedCalls}</b> 次模型调用（每 {decisionInterval} 根问一次）
                </>
              )}
            </>
          )}
        </div>

        <div className="grid-2">
          <SelectField
            label="对照连接"
            value={connectionId}
            options={store.connections.map((c) => ({
              value: c.id,
              label: `${c.label} · ${c.adapter.name}${c.adapter.tradingMode === "futures" ? " · 合约" : ""}`,
            }))}
            onChange={(v) => {
              setConnectionId(v);
              setResult(null);
              setSeries([]);
              setError(null);
            }}
          />
          <NumberField
            label="每标的 K 线数量"
            hint="各选手看到的行情完全相同；越多越慢、模型调用越多"
            value={bars}
            min={30}
            max={1000}
            step={20}
            onChange={setBars}
          />
          {simulatedTarget ? (
            <NumberField
              label="随机路径轮数"
              hint="单轮只代表一条随机路径；多轮看正收益占比与最差一轮"
              value={rounds}
              min={1}
              max={20}
              onChange={setRounds}
            />
          ) : (
            <div className="field">
              <span className="field-label">随机路径轮数</span>
              <div className="dim small" style={{ marginTop: 8 }}>
                真实行情只有一条历史，重复跑结果相同；要看随机性请选模拟行情连接。
              </div>
            </div>
          )}
          <div className="field">
            <span className="field-label">情景种子（随机行情才用得上）</span>
            <input
              className="input"
              style={{ width: 160, marginTop: 6 }}
              inputMode="numeric"
              placeholder="留空 = 每次随机"
              value={seedText}
              onChange={(e) => setSeedText(e.target.value)}
              title="模拟行情每次对照都会重掷一层随机噪声，所有选手共用同一份。多轮时以这个种子为起点逐轮 +1；留空则每轮随机。"
            />
            {!seedOk && (
              <Notice tone="warn">
                「{seedInput}」不是合法种子（要 0 或正整数）：这次会掷一条新路径，不是在复现。
              </Notice>
            )}
            {seedOk && effectiveRounds > 1 && seedInput !== "" && (
              <div className="dim small" style={{ marginTop: 4 }}>
                将从 {Number(seedInput)} 开始，连续跑 {effectiveRounds} 条可复现路径。
              </div>
            )}
          </div>
        </div>

        <div className="field" style={{ marginTop: 8 }}>
          <span className="field-label">
            {target?.symbolsBuiltIn
              ? "对照走向（交易所自带，不用选）"
              : "对照标的（来自候选池，服务端按连接解析）"}
          </span>
          <div className="chip-row" style={{ marginTop: 6 }}>
            {symbols.length > 0 ? (
              symbols.map((s) => (
                <span className="chip chip-sm mono" key={s}>
                  {s}
                </span>
              ))
            ) : (
              <span className="dim small">（无）</span>
            )}
          </div>
        </div>

        {participants.length === 0 && loaded ? (
          <div className="explain-box" style={{ marginTop: 12 }}>
            <strong>三步就能跑起来</strong>
            <p>
              ① 在 <b>交易机器人</b> 建一个机器人，或者到 <b>策略</b> 页加一条策略；
              ② 有模型的话到 <b>模型管理</b> 添加实例并填 Key；
              ③ 回到本页勾选参赛者，点「开始对照」。
            </p>
            <div className="btn-row">
              {onNavigate && (
                <Button small onClick={() => onNavigate("pool")}>
                  去候选池选标的 →
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="participant-groups">
            {groups.map(({ type, title, hint }) => {
              const items = participants.filter((p) => p.type === type);
              if (items.length === 0) return null;
              return (
                <div className="participant-group" key={type}>
                  <div className="participant-group-head">
                    <span className="strong">{title}</span>
                    <span className="dim small">{hint}</span>
                  </div>
                  <div className="participant-grid">
                    {items.map((p) => {
                      const off = Boolean(p.unavailable);
                      const on = picked.has(p.key);
                      return (
                        <button
                          key={p.key}
                          type="button"
                          className={`participant-card ${on ? "participant-on" : ""} ${off ? "participant-off" : ""}`}
                          onClick={() => !off && toggle(p.key)}
                          disabled={off}
                          title={off ? p.unavailable : undefined}
                        >
                          <div className="participant-line">
                            <Badge tone={p.type === "baseline" ? "neutral" : p.type === "bot" ? "accent" : p.type === "model" ? "warn" : undefined}>
                              {TYPE_LABEL[p.type]}
                            </Badge>
                            <span className="strong">{p.name}</span>
                            {on && <span className="participant-check">✓ 已选</span>}
                          </div>
                          <div className="dim small">{p.detail}</div>
                          <div className="participant-meta small">
                            <span className="chip chip-sm">{SOURCE_LABEL[p.decisionSource] ?? p.decisionSource}</span>
                            <span className="chip chip-sm">{p.params.engine === "adaptive" ? "自适应趋势" : "经典双均线"}</span>
                            <span className="chip chip-sm mono">
                              {p.params.fastWindow}/{p.params.slowWindow}
                            </span>
                            <span className="chip chip-sm">仓位≤{Math.round(p.params.maxTargetWeight * 100)}%</span>
                            {p.params.allowShort && <span className="chip chip-sm">可做空</span>}
                            {p.models.map((m) => (
                              <span className="chip chip-sm" key={m}>
                                {m}
                              </span>
                            ))}
                          </div>
                          {off && <div className="participant-reason small">{p.unavailable}</div>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {error && <Notice tone="error">{error}</Notice>}
        <Notice tone="info">
          对照只在模拟盘中进行，绝不会发出真实订单。所有选手共用<b>同一份行情</b>与初始资金；
          每位选手只跑自己那一类决策来源，因此是单变量比较。机器人参赛时用它引用的策略与模型，
          但资金按对照实验统一设定（不用机器人自己的资金配置）。
          {futuresTarget && (
            <div className="small" style={{ marginTop: 4 }}>
              当前连接是<b>合约模式</b>：负持仓代表做空，组合按保证金账户记账（权益 = 现金 + 未实现盈亏）。
              本地撮合不模拟资金费、维持保证金与强平；真实合约下单未开放。
            </div>
          )}
          {simulatedTarget && (
            <div className="small" style={{ marginTop: 4 }}>
              行情来自模拟行情：走向形状是写死的，叠加的噪声<b>每轮都重掷，所有选手在同一轮共用一条路径</b>。
              单轮名次只代表那一条路径；用上面的「随机路径轮数」跑多轮，看正收益占比、最差一轮和平均排名，
              才能判断是策略稳还是这一把运气好。
            </div>
          )}
          {!simulatedTarget && effectiveRounds === 1 && (
            <div className="small" style={{ marginTop: 4 }}>
              真实行情只有一条历史，重复跑会给同一个结果 —— 这不是 bug；要测随机性请选模拟行情连接。
            </div>
          )}
        </Notice>
      </Panel>

      {result && (
        <>
          <Panel
            title={series.length > 1 ? `最后一轮战绩（共 ${series.length} 轮）` : "战绩排行"}
            subtitle={`${result.bars} 根 K 线 · ${result.symbols.join(" / ")} · ${result.tradingMode === "futures" ? "合约模式 · " : ""}耗时 ${(result.durationMs / 1000).toFixed(1)}s · ${time(result.finishedAt)}${result.scenarioSeed !== undefined ? ` · 情景种子 ${result.scenarioSeed}` : ""}`}
          >
            {result.marketData === "simulated" && (
              <Notice tone="error">
                这次对照跑在<b>本地生成的行情</b>上（{result.connectionLabel ?? "模拟行情"}）：
                名次只说明"在这一轮随机路径上谁更强"，不代表真实市场里的强弱。
                判断策略稳不稳，请看下方的多轮稳定性（或把轮数调到 5 以上）；看真实表现请换用真实行情连接。
              </Notice>
            )}
            <div className="hint-line">
              看「总收益」排名；<b>最大回撤</b>越小越稳；<b>胜率</b>是盈利交易占比；
              <b>盈亏比</b>是平均盈利 / 平均亏损（∞ 表示没有亏损交易）。收益高但回撤也大的选手，实际不一定更好用。
              每位选手下方列出了它实际生效的策略参数 —— 用它核对"跑的确实是我选的那条"。
            </div>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>选手</th>
                    <th>来源</th>
                    <th>决策</th>
                    <th>实际参数</th>
                    <th className="num">总收益</th>
                    <th className="num">权益</th>
                    <th className="num">最大回撤</th>
                    <th className="num">胜率</th>
                    <th className="num">盈亏比</th>
                    <th className="num">成交</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((r, i) => (
                    <tr key={r.id} className={i === 0 ? "row-winner" : ""}>
                      <td className="mono">{i === 0 ? "🏆" : i + 1}</td>
                      <td className="strong">
                        <span className="runner-dot" style={{ background: PALETTE[i % PALETTE.length] }} />
                        {r.label}
                        {r.model && <span className="dim small"> · {r.model}</span>}
                      </td>
                      <td>
                        <Badge tone={r.origin?.type === "bot" ? "accent" : r.origin?.type === "model" ? "warn" : "neutral"}>
                          {TYPE_LABEL[r.origin?.type ?? "strategy"]}
                        </Badge>
                      </td>
                      <td className="small">{SOURCE_LABEL[r.decisionSource] ?? r.decisionSource}</td>
                      <td className="small mono dim">
                        {r.params.engine === "adaptive" ? "自适应" : "双均线"} {r.params.fastWindow}/{r.params.slowWindow} · ≤
                        {Math.round(Number(r.params.maxTargetWeight) * 100)}%
                      </td>
                      <td className={`mono num ${r.totalReturn >= 0 ? "up" : "down"}`}>{signedPct(r.totalReturn)}</td>
                      <td className="num mono">{money(r.finalEquity)}</td>
                      <td className={`num mono ${r.maxDrawdownPct > 0.15 ? "down" : "dim"}`}>{pct(r.maxDrawdownPct)}</td>
                      <td className="num mono">{r.winRate > 0 ? pct(r.winRate, 0) : "—"}</td>
                      <td className="num mono">{Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "∞"}</td>
                      <td className="num mono">{r.fillCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {aggregates.length > 0 && (
            <Panel
              title={`多轮稳定性（${series.length} 条随机路径）`}
              subtitle="每轮换一条新行情，所有选手仍共用同一轮；单轮冠军可能是运气，多轮分布才说明问题"
            >
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>选手</th>
                      <th className="num">正收益轮次</th>
                      <th className="num">平均收益</th>
                      <th className="num">中位收益</th>
                      <th className="num">最差一轮</th>
                      <th className="num">平均回撤</th>
                      <th className="num">平均排名</th>
                      <th className="num">第一名</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aggregates.map((a, i) => (
                      <tr key={a.id} className={i === 0 ? "row-winner" : ""}>
                        <td className="strong">
                          <span className="runner-dot" style={{ background: PALETTE[i % PALETTE.length] }} />
                          {a.label}
                        </td>
                        <td className={`num mono ${a.positive === a.runs ? "up" : a.positive >= a.runs * 0.9 ? "warn" : "down"}`}>
                          {a.positive} / {a.runs}
                        </td>
                        <td className={`num mono ${a.avgReturn >= 0 ? "up" : "down"}`}>{signedPct(a.avgReturn)}</td>
                        <td className={`num mono ${a.medianReturn >= 0 ? "up" : "down"}`}>{signedPct(a.medianReturn)}</td>
                        <td className={`num mono ${a.worstReturn >= 0 ? "up" : "down"}`}>{signedPct(a.worstReturn)}</td>
                        <td className="num mono dim">{pct(a.avgDrawdown)}</td>
                        <td className="num mono">{a.avgRank.toFixed(2)}</td>
                        <td className="num mono">{a.firsts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Notice tone="info">
                「正收益轮次」是期末权益高于初始资金的轮数 —— 这是用户口径里的「正收益概率」。
                90% 以上只说明在这套模拟行情的噪声里较稳，<b>不代表真实市场</b>；还要同时看最差一轮与回撤。
                每轮的种子与名次可以在下方「最后一轮」的详情里核对；用同一个起始种子可以把整组实验原样复现。
              </Notice>
              <div className="dim small" style={{ marginTop: 6 }}>
                本组情景种子：{series.map((s) => s.scenarioSeed ?? "—").join(" / ")}
              </div>
            </Panel>
          )}

          <Panel title="权益曲线对比" subtitle={series.length > 1 ? `最后一轮（第 ${series.length} 轮）的权益曲线` : "同一坐标系，越靠上越好"}>
            <CompareChart results={ranked} initialCash={result.initialCash} />
          </Panel>

          <Panel title="各选手持仓">
            <div className="grid-2">
              {ranked.map((r, i) => (
                <RunnerPositions key={r.id} result={r} color={PALETTE[i % PALETTE.length]} />
              ))}
            </div>
          </Panel>
        </>
      )}

      {!result && loaded && participants.length > 0 && !blocked && (
        <Panel title="结果">
          <Empty>勾选参赛者后点右上角「开始对照」，结果会出现在这里 —— 排名、权益曲线、各选手持仓。</Empty>
        </Panel>
      )}
    </div>
  );
}

interface RoundAggregate {
  id: string;
  label: string;
  runs: number;
  positive: number;
  firsts: number;
  avgReturn: number;
  medianReturn: number;
  worstReturn: number;
  avgDrawdown: number;
  avgRank: number;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * 把多轮对照压成一张稳定性表。
 *
 * 名次按每轮各自的总收益重排（不是把所有轮混在一起比绝对值）：
 * 行情换了，收益水平会整体平移，但"同一轮里谁更强"仍可比。
 */
function aggregateRounds(series: ComparisonResult[]): RoundAggregate[] {
  if (series.length === 0) return [];
  const ids = series[0]!.results.filter((r) => r.ok).map((r) => r.id);
  const out: RoundAggregate[] = [];
  for (const id of ids) {
    const rows = series
      .map((round) => {
        const r = round.results.find((x) => x.id === id && x.ok);
        if (!r) return null;
        const ranked = [...round.results.filter((x) => x.ok)].sort((a, b) => b.totalReturn - a.totalReturn);
        return { r, rank: ranked.findIndex((x) => x.id === id) + 1 };
      })
      .filter((x): x is { r: RunnerResult; rank: number } => x !== null);
    if (rows.length === 0) continue;
    const returns = rows.map((x) => x.r.totalReturn);
    out.push({
      id,
      label: rows[0]!.r.label,
      runs: rows.length,
      positive: returns.filter((v) => v > 0).length,
      firsts: rows.filter((x) => x.rank === 1).length,
      avgReturn: returns.reduce((a, b) => a + b, 0) / returns.length,
      medianReturn: medianOf(returns),
      worstReturn: Math.min(...returns),
      avgDrawdown: rows.reduce((a, x) => a + x.r.maxDrawdownPct, 0) / rows.length,
      avgRank: rows.reduce((a, x) => a + x.rank, 0) / rows.length,
    });
  }
  return out.sort((a, b) => b.avgReturn - a.avgReturn);
}

function CompareChart({ results, initialCash }: { results: RunnerResult[]; initialCash: number }) {  const W = 900;
  const H = 300;
  const pad = { top: 18, right: 20, bottom: 26, left: 64 };
  // 悬停十字线：多条线同屏时更要能对齐读数 —— 十字线 + 各选手同一横截面的权益
  const [hover, setHover] = useState<number | null>(null);

  const series = results.filter((r) => r.equityCurve.length > 1);
  if (series.length === 0) return <Empty>暂无权益数据</Empty>;

  const all = series.flatMap((r) => r.equityCurve.map((p) => p.equity));
  const min = Math.min(...all, initialCash);
  const max = Math.max(...all, initialCash);
  const span = max - min || Math.max(max * 0.01, 1);
  const maxLen = Math.max(...series.map((r) => r.equityCurve.length));

  const x = (i: number, len: number) => pad.left + (len <= 1 ? 0 : (i / (len - 1)) * (W - pad.left - pad.right));
  const y = (v: number) => pad.top + (1 - (v - min) / span) * (H - pad.top - pad.bottom);

  return (
    <div className="chart-wrap">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart"
        role="img"
        aria-label="权益曲线对比"
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const rel = ((e.clientX - rect.left) / rect.width) * W;
          const i = Math.round(((rel - pad.left) / (W - pad.left - pad.right)) * (maxLen - 1));
          setHover(i >= 0 && i < maxLen ? i : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const v = min + span * t;
          return (
            <g key={t}>
              <line x1={pad.left} x2={W - pad.right} y1={y(v)} y2={y(v)} className="grid-line" />
              <text x={pad.left - 10} y={y(v) + 4} className="axis-text" textAnchor="end">
                {money(v, 0)}
              </text>
            </g>
          );
        })}
        <line x1={pad.left} x2={W - pad.right} y1={y(initialCash)} y2={y(initialCash)} className="baseline-line" />
        {series.map((r, idx) => {
          const color = PALETTE[idx % PALETTE.length];
          const d = r.equityCurve
            .map((p, i) => `${i === 0 ? "M" : "L"}${x(i, r.equityCurve.length).toFixed(1)},${y(p.equity).toFixed(1)}`)
            .join(" ");
          return <path key={r.id} d={d} fill="none" stroke={color} strokeWidth={2} />;
        })}
        {hover !== null && (
          <>
            <line
              x1={pad.left + ((W - pad.left - pad.right) * hover) / (maxLen - 1)}
              x2={pad.left + ((W - pad.left - pad.right) * hover) / (maxLen - 1)}
              y1={pad.top}
              y2={H - pad.bottom}
              className="cursor-line"
            />
            {series.map((r, idx) => {
              if (hover >= r.equityCurve.length) return null;
              const p = r.equityCurve[hover]!;
              return (
                <circle
                  key={r.id}
                  cx={x(hover, r.equityCurve.length)}
                  cy={y(p.equity)}
                  r={3.5}
                  fill={PALETTE[idx % PALETTE.length]}
                />
              );
            })}
          </>
        )}
      </svg>
      {hover !== null && (
        <div className="chart-tooltip">
          <div className="dim" style={{ fontSize: 11 }}>第 {hover + 1} / {maxLen} 点</div>
          {series.map((r) =>
            hover < r.equityCurve.length ? (
              <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="runner-dot" style={{ background: PALETTE[series.indexOf(r) % PALETTE.length] }} />
                <span className="small">{r.label}</span>
                <span className="mono small" style={{ marginLeft: "auto" }}>{money(r.equityCurve[hover]!.equity)}</span>
              </div>
            ) : null,
          )}
        </div>
      )}
      <div className="chart-legend">
        {series.map((r, idx) => (
          <span className="legend-item" key={r.id}>
            <span className="runner-dot" style={{ background: PALETTE[idx % PALETTE.length] }} />
            {r.label}
            <b className={r.totalReturn >= 0 ? "up" : "down"}>{signedPct(r.totalReturn)}</b>
          </span>
        ))}
        <span className="legend-item dim">共 {maxLen} 个数据点</span>
      </div>
    </div>
  );
}

function RunnerPositions({ result, color }: { result: RunnerResult; color: string }) {
  return (
    <div className="runner-positions">
      <div className="runner-positions-head">
        <span className="runner-dot" style={{ background: color }} />
        <span className="strong">{result.label}</span>
        <span className={`mono ${result.totalReturn >= 0 ? "up" : "down"}`}>{pct(result.totalReturn)}</span>
      </div>
      {result.positions.length === 0 ? (
        <div className="dim small">空仓</div>
      ) : (
        <table className="table">
          <tbody>
            {result.positions.map((p) => (
              <tr key={p.symbol}>
                <td className="mono">
                  {p.symbol}
                  {p.quantity < 0 && <span className="chip chip-sm chip-live" style={{ marginLeft: 6 }}>空</span>}
                </td>
                <td className="num mono">{p.quantity.toFixed(4)}</td>
                <td className="num mono dim">成本 {money(p.avgCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
