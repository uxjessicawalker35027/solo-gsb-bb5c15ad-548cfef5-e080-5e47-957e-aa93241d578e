import { useState } from 'react';
import type { Cue } from '../types';
import type { RefDiffComputation, RefPair } from '../lib/refDiff';
import { pairDeviationExceeds } from '../lib/refDiff';
import { secondsToSrtTime } from '../lib/srt';

interface RefDiffPanelProps {
  /** 参考文件名；未导入为 null */
  refName: string | null;
  /** 参考轨条数（未导入为 0） */
  refCount: number;
  /** 配对规模超限（文件过大放弃计算） */
  tooLarge: boolean;
  /** 差异计算结果；未导入或超限时为 null */
  diff: RefDiffComputation<Cue> | null;
  /** 起止偏差阈值（秒），可调 */
  threshold: number;
  onImport: (file: File) => void;
  onClear: () => void;
  onThresholdChange: (v: number) => void;
  /** 点击结果行：定位时间轴；cueId 为当前轨字幕 id（参考独有为 null） */
  onLocate: (time: number, cueId: string | null) => void;
}

type TabKey = 'deviation' | 'current-only' | 'ref-only';

function formatDelta(v: number): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}s`;
}

/**
 * 参考字幕差异审阅面板（停靠在舞台底部）：
 * 参考 SRT 在当前工作区之外导入，不替换正在校对的字幕；两轨按文本相同做
 * 一对一单调配对，列出「偏差超阈值 / 当前独有 / 参考独有」三组结果，
 * 点击行定位时间轴并展示两侧时间码。参考轨与审阅状态仅保留在当前页面。
 */
export default function RefDiffPanel(p: RefDiffPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState<TabKey>('deviation');

  const diff = p.diff;
  const deviations: RefPair[] = diff
    ? diff.pairs.filter((pair) => pairDeviationExceeds(pair, p.threshold))
    : [];

  const summary = diff
    ? `配对 ${diff.pairs.length} · 偏差 ${deviations.length} · 当前独有 ${diff.currentOnly.length} · 参考独有 ${diff.refOnly.length}`
    : p.tooLarge
      ? '文件过大，无法配对'
      : '未导入参考字幕';

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: 'deviation', label: '偏差超阈值', count: deviations.length },
    { key: 'current-only', label: '当前独有', count: diff?.currentOnly.length ?? 0 },
    { key: 'ref-only', label: '参考独有', count: diff?.refOnly.length ?? 0 }
  ];

  return (
    <section className={`refdiff-panel ${collapsed ? 'collapsed' : ''}`}>
      <div className="refdiff-head" onClick={() => setCollapsed((c) => !c)}>
        <span className="refdiff-title">⇄ 参考差异审阅</span>
        <span className="refdiff-summary">{summary}</span>
        {p.refName && (
          <span className="refdiff-file" title={p.refName}>
            参考：{p.refName}（{p.refCount} 条）
          </span>
        )}
        <span className="refdiff-spacer" />
        <label
          className="refdiff-threshold"
          title="已配对条目的起点或终点偏差绝对值超过该阈值即列入「偏差超阈值」（恰好等于不算）"
          onClick={(e) => e.stopPropagation()}
        >
          偏差阈值
          <input
            type="number"
            min={0}
            max={10}
            step={0.05}
            value={p.threshold}
            onChange={(e) => p.onThresholdChange(Math.max(0, Number(e.target.value) || 0))}
          />
          s
        </label>
        <label
          className="btn mini"
          title="导入一份参考 SRT 与当前字幕比对；不会替换当前工作区，仅保留在当前页面"
          onClick={(e) => e.stopPropagation()}
        >
          导入参考 SRT
          <input
            type="file"
            accept=".srt,text/plain"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) p.onImport(f);
              e.target.value = '';
            }}
          />
        </label>
        {p.refName && (
          <button
            className="btn mini danger"
            title="清除参考轨与审阅结果（不影响当前字幕）"
            onClick={(e) => {
              e.stopPropagation();
              p.onClear();
            }}
          >
            清除
          </button>
        )}
        <span className="refdiff-collapse">{collapsed ? '▸ 展开' : '▾ 收起'}</span>
      </div>

      {!collapsed && (
        <div className="refdiff-body">
          {!p.refName && (
            <div className="refdiff-empty">
              导入一份参考 SRT（如原始字幕、他人校对版）与当前字幕按文本配对，列出偏差超阈值、当前独有与参考独有的条目；参考轨不会替换当前工作区，也不写入会话。
            </div>
          )}
          {p.refName && p.tooLarge && (
            <div className="refdiff-empty">
              两轨规模乘积超出配对上限，无法计算差异；请拆分文件后再试。
            </div>
          )}
          {p.refName && diff && (
            <>
              <div className="refdiff-tabs">
                {tabs.map((t) => (
                  <button
                    key={t.key}
                    className={`refdiff-tab ${tab === t.key ? 'active' : ''}`}
                    onClick={() => setTab(t.key)}
                  >
                    {t.label}
                    <span className="refdiff-tab-count">{t.count}</span>
                  </button>
                ))}
                <span className="refdiff-hint">点击行定位时间轴（当前轨条目同步选中）</span>
              </div>

              <div className="refdiff-list">
                {tab === 'deviation' &&
                  (deviations.length === 0 ? (
                    <div className="refdiff-empty">没有起止偏差超过阈值的已配对条目</div>
                  ) : (
                    deviations.map((pair) => {
                      const cur = diff.current[pair.cur];
                      const ref = diff.reference[pair.ref];
                      return (
                        <div
                          key={`d-${pair.cur}-${pair.ref}`}
                          className="refdiff-row"
                          title="点击定位到当前字幕起点"
                          onClick={() => p.onLocate(cur.start, cur.id)}
                        >
                          <span className="refdiff-time cur">
                            {secondsToSrtTime(cur.start)}
                            <br />
                            {secondsToSrtTime(cur.end)}
                          </span>
                          <span className="refdiff-time ref">
                            {secondsToSrtTime(ref.start)}
                            <br />
                            {secondsToSrtTime(ref.end)}
                          </span>
                          <span
                            className={`refdiff-delta ${Math.abs(pair.startDelta) > p.threshold ? 'over' : ''}`}
                          >
                            起 {formatDelta(pair.startDelta)}
                          </span>
                          <span
                            className={`refdiff-delta ${Math.abs(pair.endDelta) > p.threshold ? 'over' : ''}`}
                          >
                            止 {formatDelta(pair.endDelta)}
                          </span>
                          <span className="refdiff-text">{cur.text}</span>
                        </div>
                      );
                    })
                  ))}

                {tab === 'current-only' &&
                  (diff.currentOnly.length === 0 ? (
                    <div className="refdiff-empty">当前轨没有未配对的条目</div>
                  ) : (
                    diff.currentOnly.map((idx) => {
                      const cur = diff.current[idx];
                      return (
                        <div
                          key={`c-${idx}`}
                          className="refdiff-row"
                          title="参考轨中不存在相同文本 · 点击定位到当前字幕起点"
                          onClick={() => p.onLocate(cur.start, cur.id)}
                        >
                          <span className="refdiff-time cur">
                            {secondsToSrtTime(cur.start)}
                            <br />
                            {secondsToSrtTime(cur.end)}
                          </span>
                          <span className="refdiff-time ref none">参考轨无对应</span>
                          <span className="refdiff-text span">{cur.text}</span>
                        </div>
                      );
                    })
                  ))}

                {tab === 'ref-only' &&
                  (diff.refOnly.length === 0 ? (
                    <div className="refdiff-empty">参考轨没有未配对的条目</div>
                  ) : (
                    diff.refOnly.map((idx) => {
                      const ref = diff.reference[idx];
                      return (
                        <div
                          key={`r-${idx}`}
                          className="refdiff-row"
                          title="当前轨中不存在相同文本 · 点击定位到参考时间"
                          onClick={() => p.onLocate(ref.start, null)}
                        >
                          <span className="refdiff-time cur none">当前轨无对应</span>
                          <span className="refdiff-time ref">
                            {secondsToSrtTime(ref.start)}
                            <br />
                            {secondsToSrtTime(ref.end)}
                          </span>
                          <span className="refdiff-text span">{ref.text}</span>
                        </div>
                      );
                    })
                  ))}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
