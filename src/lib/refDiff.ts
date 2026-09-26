/**
 * 参考字幕差异审阅：文本归一化与一对一单调配对（纯函数，可单测）。
 *
 * 参考轨在当前工作区之外导入，不替换正在校对的字幕；两轨各自按时间排序后
 * 做一对一单调（保序）配对：
 * - 仅在「归一化后文本相同」的条目间建立配对（归一化 = NFKC → 去空白/标点/符号 → 小写）；
 *   归一化后为空的条目不参与配对（无法判断对应关系），直接计入各自独有；
 * - 配对保序：当前轨第 i 条配参考轨第 j 条后，i' > i 只能配 j' > j，
 *   避免重复台词或单侧插入造成后续整体错位；
 * - 在所有保序方案中先最大化配对数，再最小化配对起点时间差 |Δstart| 总和
 *   （动态规划，字典序目标：配对数降序、时间差升序）。
 */

/** 参与配对计算的最小结构（Cue 兼容） */
export interface RefDiffCue {
  start: number;
  end: number;
  text: string;
}

/** 一对已配对条目（下标基于函数返回的排序后轨道） */
export interface RefPair {
  /** 当前轨（排序后）下标 */
  cur: number;
  /** 参考轨（排序后）下标 */
  ref: number;
  /** 起点偏差：当前 − 参考（秒，带符号） */
  startDelta: number;
  /** 终点偏差：当前 − 参考（秒，带符号） */
  endDelta: number;
}

export interface RefDiffComputation<T extends RefDiffCue = RefDiffCue> {
  /** 按时间排序后的当前轨（pairs / currentOnly 的下标基准），元素为输入原引用 */
  current: T[];
  /** 按时间排序后的参考轨（pairs / refOnly 的下标基准），元素为输入原引用 */
  reference: T[];
  /** 已配对条目（按当前轨时间序） */
  pairs: RefPair[];
  /** 当前轨独有（未配对）下标，时间序 */
  currentOnly: number[];
  /** 参考轨独有（未配对）下标，时间序 */
  refOnly: number[];
}

/**
 * 归一化字幕文本：NFKC 兼容归一（全角→半角等）→ 去除所有空白、标点与符号
 * → 转小写。结果为空串的条目不参与配对。
 */
export function normalizeCueText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

/**
 * 配对单元格数量上限（(n+1)×(m+1)）：超出时放弃计算并返回 null，
 * 防止超大文件的长耗时与内存峰值卡死页面（常规字幕远低于此）。
 */
export const MAX_DIFF_CELLS = 36_000_000;

/**
 * 计算两轨的一对一单调配对与差异分类。
 * 输入任意顺序（内部按 start/end 稳定排序，元素保持原引用）；
 * 返回 null 表示规模超限。
 */
export function computeRefDiff<T extends RefDiffCue>(
  current: T[],
  reference: T[]
): RefDiffComputation<T> | null {
  const a = [...current].sort((x, y) => x.start - y.start || x.end - y.end);
  const b = [...reference].sort((x, y) => x.start - y.start || x.end - y.end);
  const n = a.length;
  const m = b.length;

  const empty: RefDiffComputation<T> = {
    current: a,
    reference: b,
    pairs: [],
    currentOnly: a.map((_, i) => i),
    refOnly: b.map((_, j) => j)
  };
  if (n === 0 || m === 0) return empty;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null;

  const normA = a.map((c) => normalizeCueText(c.text));
  const normB = b.map((c) => normalizeCueText(c.text));

  // DP：D[i][j] = 当前轨前 i 条、参考轨前 j 条的最优 (配对数, 起点时间差总和)。
  // 滚动两行存数值；决策表（每格 1 字节）记录最优来源供回溯：
  //   0 = 来自上（当前轨第 i 条不配对）
  //   1 = 来自左（参考轨第 j 条不配对）
  //   2 = 来自对角（i、j 配对）
  // 平局优先级：上 > 左 > 对角（仅影响同等最优下的具体方案，不影响最优性）。
  const W = m + 1;
  const decision = new Uint8Array((n + 1) * W);
  let prevCount = new Int32Array(W);
  let prevCost = new Float64Array(W);
  let curCount = new Int32Array(W);
  let curCost = new Float64Array(W);
  const matchRow = new Uint8Array(m);

  for (let i = 1; i <= n; i++) {
    const na = normA[i - 1];
    const aStart = a[i - 1].start;
    for (let j = 0; j < m; j++) {
      matchRow[j] = na !== '' && na === normB[j] ? 1 : 0;
    }
    curCount[0] = 0;
    curCost[0] = 0;
    for (let j = 1; j <= m; j++) {
      // 候选 0：跳过当前轨第 i 条（来自上）
      let bestCount = prevCount[j];
      let bestCost = prevCost[j];
      let bestDir = 0;
      // 候选 1：跳过参考轨第 j 条（来自左）
      if (curCount[j - 1] > bestCount || (curCount[j - 1] === bestCount && curCost[j - 1] < bestCost)) {
        bestCount = curCount[j - 1];
        bestCost = curCost[j - 1];
        bestDir = 1;
      }
      // 候选 2：文本相同则配对（来自对角）
      if (matchRow[j - 1] === 1) {
        const c = prevCount[j - 1] + 1;
        const k = prevCost[j - 1] + Math.abs(aStart - b[j - 1].start);
        if (c > bestCount || (c === bestCount && k < bestCost)) {
          bestCount = c;
          bestCost = k;
          bestDir = 2;
        }
      }
      curCount[j] = bestCount;
      curCost[j] = bestCost;
      decision[i * W + j] = bestDir;
    }
    const tc = prevCount;
    prevCount = curCount;
    curCount = tc;
    const tk = prevCost;
    prevCost = curCost;
    curCost = tk;
  }

  // 回溯决策表，得到配对序列（逆序收集后翻转）
  const pairs: RefPair[] = [];
  const pairedA = new Uint8Array(n);
  const pairedB = new Uint8Array(m);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const d = decision[i * W + j];
    if (d === 2) {
      pairs.push({
        cur: i - 1,
        ref: j - 1,
        startDelta: a[i - 1].start - b[j - 1].start,
        endDelta: a[i - 1].end - b[j - 1].end
      });
      pairedA[i - 1] = 1;
      pairedB[j - 1] = 1;
      i--;
      j--;
    } else if (d === 1) {
      j--;
    } else {
      i--;
    }
  }
  pairs.reverse();

  const currentOnly: number[] = [];
  for (let k = 0; k < n; k++) if (pairedA[k] === 0) currentOnly.push(k);
  const refOnly: number[] = [];
  for (let k = 0; k < m; k++) if (pairedB[k] === 0) refOnly.push(k);

  return { current: a, reference: b, pairs, currentOnly, refOnly };
}

/**
 * 起止偏差是否超过阈值：|Δ起点| 或 |Δ终点| 严格大于阈值（恰好等于不算）。
 * 阈值负值按 0 计。
 */
export function pairDeviationExceeds(pair: RefPair, threshold: number): boolean {
  const t = Math.max(0, threshold);
  return Math.abs(pair.startDelta) > t || Math.abs(pair.endDelta) > t;
}
