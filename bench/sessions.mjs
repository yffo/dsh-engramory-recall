/**
 * LongMemEval-S 的 session → 笔记映射（harness 与池宽尺子共用一份，避免两处口径漂移）。
 *
 * 一个 session 就是一篇「笔记」：轮次按顺序拼、role 前缀保留（user/assistant 的用词分布不同）。
 * `mtimeMs: 0` 是**故意的**：数据集里的 `haystack_dates` 是「事件发生的时间」，
 * 而题目问的日期（`question_date`）可以晚很多 —— 把 mtime 填成 session 日期会让引擎以为
 * 「越新的越相关」，但实测 gold 的新度百分位平均是 0.459（随机水平，见
 * `reference-engramory-recall-tuning.md` 第九条被证伪的路），所以照原样留 0。
 */
export function sessionToDoc(sessionId, turns) {
  const lines = [];
  for (const turn of turns) {
    const role = turn?.role === 'assistant' ? 'Assistant' : 'User';
    const text = String(turn?.content ?? '').trim();
    if (text) lines.push(`${role}: ${text}`);
  }
  return { id: sessionId, title: '', description: '', body: lines.join('\n'), aliases: [], lines: [], mtimeMs: 0 };
}
