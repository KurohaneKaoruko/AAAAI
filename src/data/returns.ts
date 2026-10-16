/** 收益序列工具：把 K 线转成对齐的对数收益，供协方差/相关性计算使用。 */

/** 对数收益序列（对齐多个标的时按各自可用长度，各自返回）。 */
export function returnsOf(bars: { close: number }[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const p0 = bars[i - 1]!.close;
    if (p0 > 0) out.push(Math.log(bars[i]!.close / p0));
  }
  return out;
}