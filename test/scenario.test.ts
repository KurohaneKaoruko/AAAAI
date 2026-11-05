/**
 * 随机情景（模拟交易所的行情生成）：
 *
 * 模拟行情存在的唯一理由是"在不可预测的行情上考察策略"。早期版本按 symbol
 * 哈希播种，同一代码每次走势完全相同 —— 那测出来的只是"一条任意路径上的运气"，
 * 而且换个策略比也不公平（大家做的是不同的题）。
 *
 * 这个文件把三条性质锁死：
 * 1. **随机**：每次新情景都掷出不同的路径，否则"抗随机能力"无从谈起；
 * 2. **自洽**：同一情景内同一时刻必得同一根 K 线（取数顺序无关、历史不会被改写）——
 *    实时机器人的预热段与后续成交、多次取数的重叠部分都必须对得上；
 * 3. **可复现**：给了种子就原样重现，让任何一次随机结果都能被核对，而不是无法查证。
 *
 * 另外锁住调用方的两条约定：历史模拟每次换新路径；模拟对照只换一次
 * （所有参赛者做同一套题，否则名次没有意义）。
 *
 * 还要分清两层：**走向的形状是写死的**（单边上行就一路上行、急速跳水就横盘后急跌），
 * **掷随机的只是叠在上面的噪声**。形状随种子乱跳的话，"在阴跌行情下策略还行不行"
 * 就无从谈起 —— 那测的是另一条走向。下面「走向」那条用例把这件事钉住。
 */

// 本文件要显式验证"随机"，所以必须清掉 helpers 里的固定种子与固定时钟
delete process.env.AAAAI_SIM_SEED;
delete process.env.AAAAI_SIM_NOW;

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SimulatedAdapter } from "./lib/simMarket.js";
import { testConfig } from "./helpers.js";

/** 一个新的模拟适配器（不带固定种子 → 每次构造都是随机情景）。 */
function randomAdapter(): SimulatedAdapter {
  const a = new SimulatedAdapter();
  a.init({ apiKey: "", apiSecret: "", testnet: false });
  return a;
}

function closes(bars: { close: number }[]): string {
  return bars.map((b) => b.close).join(",");
}

test("随机情景：换一个情景就是一条新路径（同一代码不再每次长一样）", async () => {
  const a = randomAdapter();
  a.newScenario(1);
  const first = await a.fetchKlines("单边上行", "1d", 120);
  a.newScenario(2);
  const second = await a.fetchKlines("单边上行", "1d", 120);
  assert.notEqual(closes(first), closes(second), "两条情景路径必须不同，否则测的还是同一条路的运气");
});

test("随机情景：连续掷 10 次，至少 9 次路径互不相同（排除偶然重复）", async () => {
  const a = randomAdapter();
  const paths = new Set<string>();
  for (let i = 0; i < 10; i += 1) {
    a.newScenario();
    paths.add(closes(await a.fetchKlines("BTCUSDT", "1d", 120)));
  }
  assert.ok(paths.size >= 9, `10 次随机情景应给出基本互不相同的路径，实际只有 ${paths.size} 种`);
});

test("情景内自洽：同一情景重复取数逐字节一致，取数顺序也不影响重叠部分", async () => {
  const a = randomAdapter();
  a.newScenario(7);
  const wide = await a.fetchKlines("震荡整理", "1h", 200);
  const wideAgain = await a.fetchKlines("震荡整理", "1h", 200);
  assert.deepEqual(wide, wideAgain, "同一情景同一窗口必须逐字节一致（历史不能自己变）");

  // 先取长窗口再取短窗口：重叠的 50 根必须一致，否则预热段和后续成交会对不上
  const narrow = await a.fetchKlines("震荡整理", "1h", 50);
  assert.deepEqual(
    wide.slice(-50),
    narrow,
    "重叠窗口必须一致（取数顺序不得影响结果）",
  );
});

test("复现：同一个种子原样重现同一个结果（随机不等于无法查证）", async () => {
  const a = randomAdapter();
  a.newScenario(20260916);
  const first = await a.fetchKlines("单边上行", "1d", 150);
  // 中间换几次情景，确认不会串味
  a.newScenario();
  a.newScenario(1);
  a.newScenario(20260916);
  const again = await a.fetchKlines("单边上行", "1d", 150);
  assert.deepEqual(first, again, "同一种子必须能原样重现");
});

test("行情特征：存在共同市场因子（标的相关性为正），否则横截面策略会被测出假象", async () => {
  const a = randomAdapter();
  let sum = 0;
  let n = 0;
  for (const seed of [11, 22, 33, 44]) {
    a.newScenario(seed);
    const [btc, eth] = await Promise.all([
      a.fetchKlines("单边上行", "1d", 150),
      a.fetchKlines("震荡整理", "1d", 150),
    ]);
    const rb = btc.slice(1).map((b, i) => Math.log(b.close / btc[i]!.close));
    const re = eth.slice(1).map((b, i) => Math.log(b.close / eth[i]!.close));
    const mb = rb.reduce((s, x) => s + x, 0) / rb.length;
    const me = re.reduce((s, x) => s + x, 0) / re.length;
    let cov = 0;
    let vb = 0;
    let ve = 0;
    for (let i = 0; i < rb.length; i += 1) {
      cov += (rb[i]! - mb) * (re[i]! - me);
      vb += (rb[i]! - mb) ** 2;
      ve += (re[i]! - me) ** 2;
    }
    const corr = cov / Math.sqrt(vb * ve);
    sum += corr;
    n += 1;
    assert.ok(corr > 0.15, `两个标的同期涨跌应明显正相关，实际 ${corr.toFixed(2)}`);
  }
  assert.ok(sum / n > 0.3, `平均相关性应明显为正，实际 ${(sum / n).toFixed(2)}`);
});

/**
 * 走向的形状：把多个种子的噪声平均掉，剩下的应当就是走向本身。
 *
 * 这一条是"这五条走向到底是干什么的"的唯一依据 —— 名字里写着上行/阴跌/横盘/跳水，
 * 就得真长成那样；否则用户在界面上选的"走向"是假的，测出来的盈利能力也没有意义。
 */
test("走向：五条走向的形状与名字相符（形状固定，随机的只是噪声）", async () => {
  const a = randomAdapter();
  const SEEDS = [11, 22, 33, 44, 55, 66, 77, 88];
  const BARS = 120;
  /** 平均掉噪声后的形状：以窗口第一根为 0 的累计对数涨跌。 */
  const shapeOf = async (symbol: string): Promise<number[]> => {
    const acc = new Array<number>(BARS).fill(0);
    for (const seed of SEEDS) {
      a.newScenario(seed);
      const bars = await a.fetchKlines(symbol, "1m", BARS);
      for (let i = 0; i < BARS; i += 1) {
        acc[i] += Math.log(bars[i]!.close / bars[0]!.close);
      }
    }
    return acc.map((v) => v / SEEDS.length);
  };

  const up = await shapeOf("单边上行");
  const down = await shapeOf("缓慢阴跌");
  const chop = await shapeOf("震荡整理");
  const crash = await shapeOf("急速跳水");
  const whip = await shapeOf("急涨急跌");
  const net = (s: number[]) => s[s.length - 1]!;

  assert.ok(net(up) > 0.15, `单边上行应明显收高，实际 ${net(up).toFixed(3)}`);
  assert.ok(net(down) < -0.1, `缓慢阴跌应明显收低，实际 ${net(down).toFixed(3)}`);
  // 横盘：净变化接近 0，但中途必须离开起点又回来（"来回"，不是一条平线）
  assert.ok(Math.abs(net(chop)) < 0.1, `震荡整理净变化应接近 0，实际 ${net(chop).toFixed(3)}`);
  assert.ok(Math.max(...chop.map(Math.abs)) > 0.15, "震荡整理窗口内应有明显来回");
  assert.ok(net(crash) < -0.3, `急速跳水应明显收低，实际 ${net(crash).toFixed(3)}`);
  // 急涨急跌：中途冲得比起点高 20% 以上，最后又落回起点之下
  assert.ok(Math.max(...whip) > 0.2, "急涨急跌中途应有明显上冲");
  assert.ok(net(whip) < 0, `急涨急跌应冲高后回落，实际 ${net(whip).toFixed(3)}`);
  // 名字之间也得对得上：上行明显强于阴跌（不是两条形状差不多的随机线）
  assert.ok(net(up) - net(down) > 0.25, "上行与阴跌必须是方向相反的两种走向");
});

test("行情量级：波动率落在可信区间，价格不会在窗口内飘到离谱", async () => {
  const a = randomAdapter();
  for (const symbol of ["BTCUSDT", "单边上行"]) {
    const perBar: number[] = [];
    const spans: number[] = [];
    for (const seed of [101, 202, 303, 404]) {
      a.newScenario(seed);
      const bars = await a.fetchKlines(symbol, "1d", 200);
      const rets = bars.slice(1).map((b, i) => Math.log(b.close / bars[i]!.close));
      const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
      perBar.push(Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length));
      spans.push(Math.log(Math.max(...bars.map((b) => b.high)) / Math.min(...bars.map((b) => b.low))));
    }
    const avgVol = perBar.reduce((s, x) => s + x, 0) / perBar.length;
    // 日波动率应在"温和"到"很颠簸"之间；太可能是没波动（看不出策略差别），
    // 太大则是标定坏了（随机行情不该比真实行情更疯）
    assert.ok(avgVol > 0.004 && avgVol < 0.05, `${symbol} 日波动 ${avgVol} 不在合理区间`);
    // 200 个交易日的最高/最低跨度对数幅度：超过 2（约 7 倍）就不像行情了
    const maxSpan = Math.max(...spans);
    assert.ok(maxSpan < 2, `${symbol} 200 日区间跨度 ${maxSpan.toFixed(2)} 过大（价格已失真）`);
  }
});
