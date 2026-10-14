/**
 * 对照基线：教科书 BM25，**在本文件里独立实现**，不 import 我们的 bm25.js。
 *
 * 为什么要独立写一份、而不是把我们自己的代码关几个开关：
 *   - 自己关自己的开关，容易关不干净（少关一处，基线就"变强"，结论就偏乐观）；
 *   - 读者要看的是「和常规写法比，你到底多拿到什么」，独立实现才说得清。
 *
 * 两种基线：
 *   `unigram` —— 最朴素的写法：英文按词、中文**逐字**。很多轻量检索就这么干。
 *   `bigram`  —— 与我们的分词口径一致（单字 + 相邻双字），但**没有**任何额外机制：
 *                没有字段加权、没有同义扩展、没有别名、没有整篇长度归一。
 *                它把我们"多做的事"单独隔离出来。
 */

function tokenizeUnigram(text) {
  const s = String(text ?? '').toLowerCase();
  const out = [];
  for (const w of s.match(/[a-z0-9_+.#/-]{2,}/g) ?? []) {
    out.push(w);
    if (/[-/.]/.test(w)) for (const part of w.split(/[-/.]+/)) if (part.length >= 2) out.push(part);
  }
  for (const ch of s.replace(/[^\u4e00-\u9fff]/g, '')) out.push(ch);
  return out;
}

function tokenizeBigram(text) {
  const s = String(text ?? '').toLowerCase();
  const out = [];
  for (const w of s.match(/[a-z0-9_+.#/-]{2,}/g) ?? []) {
    out.push(w);
    if (/[-/.]/.test(w)) for (const part of w.split(/[-/.]+/)) if (part.length >= 2) out.push(part);
  }
  for (const run of s.replace(/[^\u4e00-\u9fff]/g, ' ').split(/\s+/)) {
    if (!run) continue;
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

const K1 = 1.2;
const B = 0.75;

/**
 * @param {'unigram'|'bigram'} mode
 * @returns {{name: string, build(docs: Array): object, search(index: object, query: string, limit?: number): Array}}
 */
export function createBaseline(mode) {
  const tokenize = mode === 'bigram' ? tokenizeBigram : tokenizeUnigram;
  return {
    name: mode === 'bigram' ? '基线：同分词口径的教科书 BM25' : '基线：教科书 BM25（中文逐字）',
    build(docs) {
      const prepared = docs.map((doc) => {
        const tf = new Map();
        const tokens = tokenize([doc.title, doc.description, doc.body].filter(Boolean).join('\n'));
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
        return { id: doc.id, tf, len: tokens.length || 1 };
      });
      const avgLen = prepared.reduce((n, d) => n + d.len, 0) / (prepared.length || 1) || 1;
      return { docs: prepared, avgLen };
    },
    search(index, query, limit = 5) {
      const terms = [...new Set(tokenize(query))];
      if (!terms.length) return [];
      const { docs, avgLen } = index;
      const df = new Map();
      for (const term of terms) {
        let n = 0;
        for (const doc of docs) if (doc.tf.has(term)) n++;
        df.set(term, n);
      }
      const total = docs.length || 1;
      const hits = [];
      for (const doc of docs) {
        let score = 0;
        for (const term of terms) {
          const f = doc.tf.get(term) ?? 0;
          if (!f) continue;
          const n = df.get(term) ?? 0;
          const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5));
          score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.len) / avgLen)));
        }
        if (score > 0) hits.push({ id: doc.id, score });
      }
      hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
      return hits.slice(0, limit);
    },
  };
}
