/**
 * dsh-engramory-recall —— Web 客户端半侧：「记忆」标签页。
 *
 * 这是**手写**的客户端 bundle，刻意不引入任何构建链：
 * 客户端模块系统要的格式就是一句 `window.__ModuleLoader__.load({ id, factory })`，
 * factory 里 `require('react')` 拿的是外壳冻结的平台基座（PLATFORM_MODULES），
 * 所以整个插件仍然零依赖、零出网、可 git diff。
 *
 * 数据来自宿主侧注册的只读路由 /api/engramory-recall/state（见 ../index.js）：
 * 记忆库快照（索引 + 笔记清单）+ 最近 80 个用户轮的召回判定留痕。
 *
 * 改这个文件后**刷新页面**即可生效（客户端 bundle 走 HMR 的 rebuilt 通道）；
 * 改宿主侧 index.js 则必须重启 App。
 */
window.__ModuleLoader__.load({
  id: 'dsh-engramory-recall',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const STATE_URL = '/api/engramory-recall/state';
    const POLL_MS = 3000;

    /** 深浅色都成立的克制配色：底子用 currentColor 的透明度，不假设主题变量存在。 */
    const dim = (pct) => `color-mix(in srgb, currentColor ${pct}%, transparent)`;
    const S = {
      root: { height: '100%', overflow: 'auto', padding: '14px 18px 28px', fontSize: '12.5px', lineHeight: '1.6' },
      row: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
      muted: { color: dim(55) },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      card: { border: `1px solid ${dim(14)}`, borderRadius: '8px', padding: '10px 12px', marginTop: '10px' },
      title: { fontSize: '13px', fontWeight: 600, margin: '16px 0 6px' },
      chip: (tone) => ({
        display: 'inline-block', padding: '0 6px', borderRadius: '999px', fontSize: '11px',
        border: `1px solid ${dim(22)}`,
        color: tone === 'hit' ? '#2e9e63' : tone === 'skip' ? dim(55) : tone === 'deny' ? '#d24b4b' : tone === 'sediment' ? '#3d7bbf' : '#c2803a',
        borderColor: tone === 'hit' ? '#2e9e6355' : tone === 'skip' ? dim(14) : tone === 'deny' ? '#d24b4b55' : tone === 'sediment' ? '#3d7bbf55' : '#c2803a55',
      }),
      table: { width: '100%', borderCollapse: 'collapse' },
      th: { textAlign: 'left', fontWeight: 500, color: dim(55), padding: '4px 8px 4px 0', borderBottom: `1px solid ${dim(14)}` },
      td: { padding: '4px 8px 4px 0', borderBottom: `1px solid ${dim(8)}`, verticalAlign: 'top' },
      pre: { margin: '6px 0 0', padding: '8px 10px', background: dim(6), borderRadius: '6px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      btn: { background: 'transparent', border: `1px solid ${dim(18)}`, borderRadius: '6px', color: 'inherit', cursor: 'pointer', padding: '1px 8px', fontSize: '11.5px' },
    };

    const fmtBytes = (n) => {
      const v = Number(n) || 0;
      if (v < 1024) return `${v} B`;
      if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
      return `${(v / 1024 / 1024).toFixed(2)} MB`;
    };

    const fmtTime = (ms) => {
      const d = new Date(Number(ms) || Date.now());
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };

    /** 轮询宿主状态；失败不清空已有数据，只把错误挂出来（面板不该因一次抖动变白）。 */
    function useRecallState() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [at, setAt] = React.useState(0);

      React.useEffect(() => {
        let alive = true;
        const load = () => {
          fetch(STATE_URL, { headers: { accept: 'application/json' } })
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
            .then((data) => { if (alive) { setState(data); setError(null); setAt(Date.now()); } })
            .catch((err) => { if (alive) setError(String(err && err.message ? err.message : err)); });
        };
        load();
        const timer = setInterval(load, POLL_MS);
        return () => { alive = false; clearInterval(timer); };
      }, []);

      return { state, error, at };
    }

    function Stat({ label, value, hint }) {
      return h('div', { style: { minWidth: '104px' } },
        h('div', { style: S.muted }, label),
        h('div', { style: { ...S.mono, fontSize: '15px' } }, value),
        hint ? h('div', { style: { ...S.muted, fontSize: '11px' } }, hint) : null);
    }

    function LogEntry({ entry, expanded, onToggle }) {
      const tone = entry.kind === 'hit' ? 'hit' : entry.kind === 'skip' ? 'skip' : entry.kind === 'deny' ? 'deny' : entry.kind === 'sediment' ? 'sediment' : 'empty';
      const label = entry.kind === 'hit' ? `注入 ${entry.injected} 条`
        : entry.kind === 'skip' ? '跳过'
        : entry.kind === 'deny' ? '拦截写入'
        : entry.kind === 'deny-error' ? '闸门异常'
        : entry.kind === 'sediment' ? '沉淀提醒' : '无命中';
      const hits = Array.isArray(entry.hits) ? entry.hits : [];

      return h('div', { style: { padding: '7px 0', borderBottom: `1px solid ${dim(8)}` } },
        h('div', { style: S.row },
          h('span', { style: { ...S.mono, ...S.muted } }, fmtTime(entry.at)),
          h('span', { style: S.chip(tone) }, label),
          h('span', { style: { flex: '1 1 240px', minWidth: '180px' } }, entry.query || '（空）'),
          entry.kind === 'hit' ? h('span', { style: { ...S.muted, ...S.mono } }, `${entry.chars} 字符`) : null,
          entry.nudge ? h('span', { style: S.chip('empty') }, '含记忆提示') : null,
          hits.length ? h('button', { style: S.btn, onClick: onToggle }, expanded ? '收起' : '展开') : null),
        hits.length ? h('div', { style: { ...S.row, marginTop: '3px' } },
          hits.slice(0, 4).map((hit, i) => h('span', {
            key: i,
            style: { ...S.mono, ...S.muted, fontSize: '11.5px' },
          }, `${hit.id}${hit.section ? ` § ${hit.section}` : ''} · ${hit.score}`))) : null,
        entry.reason ? h('div', { style: { ...S.muted, fontSize: '11.5px', marginTop: '4px' } }, entry.reason) : null,
        expanded ? h('pre', { style: { ...S.pre, ...S.mono, fontSize: '11.5px' } },
          hits.map((hit, i) => `${i + 1}. ${hit.id}${hit.section ? ` § ${hit.section}` : ''}  score=${hit.score}  ${hit.bytes}B`).join('\n')) : null);
    }

    function MemoryView() {
      const { state, error, at } = useRecallState();
      const [tab, setTab] = React.useState('log');
      const [expanded, setExpanded] = React.useState(-1);
      const [filter, setFilter] = React.useState('');

      if (!state) {
        return h('div', { style: S.root },
          h('div', null, '正在读取记忆库状态…'),
          error ? h('div', { style: { color: '#c2803a' } }, `宿主路由不可用：${error}`) : null);
      }

      const log = Array.isArray(state.log) ? state.log : [];
      const notes = Array.isArray(state.notes) ? state.notes : [];
      const audit = state.audit || null;
      const findings = Array.isArray(audit && audit.findings) ? audit.findings : [];
      const SEV_ORDER = { error: 0, warn: 1, info: 2 };
      const SEV_COLOR = { error: '#c25a4a', warn: '#c2803a', info: dim(55) };
      const SEV_ICON = { error: '⛔', warn: '⚠️', info: 'ℹ️' };
      const sortedFindings = [...findings].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
      const totals = state.totals || { notes: 0, docs: 0, bytes: 0 };
      const index = state.index || { lines: 0, bytes: 0, text: '' };
      const writeAudit = state.writeAudit || { epoch: '', entries: [] };
      const auditEntries = Array.isArray(writeAudit.entries) ? writeAudit.entries : [];
      const denied = auditEntries.filter((e) => e.verdict === 'deny').length;
      const stats = log.reduce((acc, item) => {
        acc[item.kind] = (acc[item.kind] || 0) + 1;
        if (item.kind === 'hit') acc.chars += Number(item.chars) || 0;
        return acc;
      }, { hit: 0, empty: 0, skip: 0, deny: 0, chars: 0 });

      const shown = filter
        ? notes.filter((note) => `${note.file} ${note.title} ${note.description}`.toLowerCase().includes(filter.toLowerCase()))
        : notes;

      const tabBtn = (id, text) => h('button', {
        key: id,
        style: { ...S.btn, borderColor: tab === id ? dim(45) : dim(18), fontWeight: tab === id ? 600 : 400 },
        onClick: () => setTab(id),
      }, text);

      return h('div', { style: S.root },
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('div', { style: S.row },
            h('span', { style: S.title && { fontSize: '13px', fontWeight: 600 } }, 'Engramory 记忆库'),
            h('span', { style: { ...S.muted, ...S.mono, fontSize: '11.5px' } }, state.store || '未配置')),
          h('span', { style: { ...S.muted, fontSize: '11px' } }, at ? `更新于 ${fmtTime(at)}` : '')),
        error ? h('div', { style: { color: '#c2803a', marginTop: '4px' } }, `状态过期：${error}`) : null,

        h('div', { style: { ...S.row, gap: '22px', marginTop: '12px' } },
          h(Stat, { label: '笔记', value: totals.notes, hint: `${totals.docs} 个检索片段` }),
          h(Stat, { label: '库大小', value: fmtBytes(totals.bytes) }),
          h(Stat, { label: '索引', value: `${index.lines} 行`, hint: fmtBytes(index.bytes) }),
          h(Stat, { label: '本轮注入', value: stats.hit ? `${stats.hit} 次` : '—', hint: stats.chars ? `共 ${stats.chars} 字符` : '尚无命中' }),
          h(Stat, { label: '闸门拦截', value: stats.deny ? `${stats.deny} 次` : '—', hint: stats.deny ? '写记忆库被拒' : '尚无拦截' })),

        h('div', { style: { ...S.row, gap: '6px', marginTop: '16px' } },
          tabBtn('log', `召回日志（${log.length}）`),
          tabBtn('notes', `笔记（${notes.length}）`),
          tabBtn('audit', (() => {
            const b = audit && audit.summary && audit.summary.bySeverity;
            const n = b ? (b.error || 0) + (b.warn || 0) : 0;
            return n > 0 ? `体检（${n}）` : '体检';
          })()),
          tabBtn('index', '索引原文'),
          tabBtn('writes', `写入审计（${auditEntries.length}）`)),

        tab === 'log' ? h('div', { style: S.card },
          log.length ? log.map((entry, i) => h(LogEntry, {
            key: `${entry.at}-${i}`,
            entry,
            expanded: expanded === i,
            onToggle: () => setExpanded(expanded === i ? -1 : i),
          })) : h('div', { style: S.muted }, '这个会话还没有召回记录。发一句真实的提问就会出现在这里。'))
          : null,

        tab === 'notes' ? h('div', { style: S.card },
          h('input', {
            value: filter,
            placeholder: '按文件名 / 标题 / 描述过滤',
            onChange: (event) => setFilter(event.target.value),
            style: { ...S.mono, width: '100%', boxSizing: 'border-box', padding: '5px 8px', marginBottom: '8px', background: dim(6), border: `1px solid ${dim(16)}`, borderRadius: '6px', color: 'inherit' },
          }),
          h('table', { style: S.table },
            h('thead', null, h('tr', null,
              h('th', { style: S.th }, '文件'),
              h('th', { style: S.th }, '标题'),
              h('th', { style: { ...S.th, textAlign: 'right' } }, '大小'),
              h('th', { style: { ...S.th, textAlign: 'right' } }, '片段'))),
            h('tbody', null, shown.map((note) => h('tr', { key: note.file },
              h('td', { style: { ...S.td, ...S.mono, fontSize: '11.5px' } }, note.file),
              h('td', { style: S.td },
                h('div', null, note.title || '—'),
                note.description ? h('div', { style: { ...S.muted, fontSize: '11.5px' } }, note.description) : null),
              h('td', { style: { ...S.td, ...S.mono, textAlign: 'right', whiteSpace: 'nowrap' } }, fmtBytes(note.bytes)),
              h('td', { style: { ...S.td, ...S.mono, textAlign: 'right' } }, note.sections > 1 ? `${note.sections}` : '1'))))))
          : null,

        tab === 'audit' ? h('div', { style: S.card },
          audit && audit.summary
            ? h('div', { style: { ...S.muted, fontSize: '11.5px', marginBottom: '8px' } },
                `${audit.summary.notes} 篇笔记 · 结构错 ${audit.summary.bySeverity.error} · 告警 ${audit.summary.bySeverity.warn} · 提示 ${audit.summary.bySeverity.info}`)
            : null,
          sortedFindings.length
            ? sortedFindings.map((f, i) => h('div', {
                key: `${f.code}-${i}`,
                style: { padding: '7px 0', borderTop: i ? `1px solid ${dim(10)}` : 'none' },
              },
                h('div', { style: { ...S.row, gap: '7px', alignItems: 'baseline' } },
                  h('span', null, SEV_ICON[f.severity] || '•'),
                  h('span', { style: { ...S.mono, fontSize: '10.5px', padding: '1px 6px', borderRadius: '999px', background: dim(8), border: `1px solid ${dim(16)}` } }, f.code),
                  h('span', { style: { color: SEV_COLOR[f.severity] || 'inherit' } }, f.message)),
                f.files && f.files.length
                  ? h('div', { style: { ...S.muted, ...S.mono, fontSize: '11px', marginTop: '3px', paddingLeft: '20px' } }, f.files.join('  ·  '))
                  : null))
            : h('div', { style: S.muted }, audit ? '✅ 没发现结构问题、失联路径或可疑重复。' : '还没拿到体检结果（宿主侧未就绪）。'))
          : null,

        tab === 'writes' ? h('div', { style: S.card },
          h('div', { style: { ...S.muted, fontSize: '11.5px', marginBottom: '8px' } },
            `规则版本 ${writeAudit.epoch || '—'} · 共 ${auditEntries.length} 条 · 拦截 ${denied} 条`),
          auditEntries.length
            ? auditEntries.map((entry, i) => h('div', {
                key: `${entry.ts}-${i}`,
                style: { padding: '7px 0', borderTop: i ? `1px solid ${dim(10)}` : 'none' },
              },
                h('div', { style: { ...S.row, gap: '8px', alignItems: 'baseline' } },
                  h('span', { style: { ...S.muted, ...S.mono, fontSize: '11px', whiteSpace: 'nowrap' } }, fmtTime(entry.ts)),
                  h('span', { style: S.chip(entry.verdict === 'deny' ? 'deny' : 'hit') }, entry.verdict === 'deny' ? '拦截' : '放行'),
                  h('span', { style: { ...S.mono, fontSize: '11px' } }, entry.tool || '?'),
                  h('span', { style: { ...S.mono, fontSize: '11.5px' } }, entry.file || '—'),
                  h('span', { style: { ...S.muted, ...S.mono, fontSize: '11px' } }, fmtBytes(entry.bytes || 0))),
                entry.reason ? h('div', { style: { color: '#d24b4b', fontSize: '11.5px', marginTop: '3px', paddingLeft: '20px' } }, entry.reason) : null))
            : h('div', { style: S.muted }, '还没有落在记忆库里的写入记录。审计从插件加载后开始记，写在 .engramory-audit.jsonl 里。'))
          : null,

        tab === 'index' ? h('div', { style: S.card },
          index.missing
            ? h('div', { style: S.muted }, `没找到索引文件：${index.path}`)
            : h('pre', { style: { ...S.pre, ...S.mono, fontSize: '11.5px', maxHeight: '62vh' } }, index.text || '（空）'))
          : null,

        // 配置回显：面板要能回答「现在到底按哪套参数在召回」。
        h('div', { style: { ...S.muted, marginTop: '14px', ...S.mono, fontSize: '11px' } },
          `maxPointers=${state.config?.maxPointers} maxChars=${state.config?.maxChars} ` +
          `minScore=${state.config?.minScore} nudge=${state.config?.nudge ? 'on' : 'off'} ` +
          `guardWrites=${state.config?.guardWrites ? 'on' : 'off'} ` +
          `enabled=${state.config?.enabled ? 'on' : 'off'}`));
    }

    return {
      name: 'engramory-recall-client',
      // 客户端 cordis 服务：只需要 slot 注册表。
      inject: ['slots'],
      apply(ctx) {
        // 「对话 | 轨迹」那一排的扩展点就是 conversation.view。
        // order 取 20（轨迹是 10），排在内建视图之后。
        // 注意：`轨迹` 默认隐藏（开发者工具关闭时被过滤），`记忆` 永远显示。
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'memory',
          order: 20,
          label: () => '记忆',
        }, MemoryView));
      },
    };
  },
});
