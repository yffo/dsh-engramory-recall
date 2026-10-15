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
 * 面板上说人话：「注入」叫**提醒**、「打开」叫**被用上**、「minScore」叫**相关度门槛**、
 * 「pointer」叫**一条提醒**。专业键名只在「当前设置」那张卡里当小字对照 ——
 * 别的地方（日志、表格、曲线、原因）一律不出英文码。
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
    const ARCHIVE_URL = '/api/engramory-recall/archive';
    /** busy 的哨兵值：正在跑「全部执行」，此时所有单篇按钮都该禁用。 */
    const ALL = '@all';
    const POLL_MS = 3000;

    /* ══ 视觉令牌 ══════════════════════════════════════════════════════════
     * 面板被嵌在宿主主题里，所以**只用 currentColor 的相对色**（color-mix 混透明度），
     * 不假设任何 CSS 变量存在、不写死底色 —— 深浅两套主题下都成立。
     * 唯一的固定色是下面这组状态色（语义色）：深浅底上对比度都够，且互相区分得开。
     * ═══════════════════════════════════════════════════════════════════ */
    const dim = (pct) => `color-mix(in srgb, currentColor ${pct}%, transparent)`;

    /** 状态色的唯一出处：hit 好事 / deny 坏事 / sediment 系统自己做的事 / note 提醒·待办 / skip 中性。 */
    const TONE = { hit: '#2e9e63', deny: '#d24b4b', sediment: '#3d7bbf', note: '#c2803a', skip: null };
    const toneColor = (tone) => (TONE[tone] === undefined ? TONE.note : TONE[tone]) || dim(55);
    const toneBorder = (tone) => (TONE[tone] ? `${TONE[tone]}55` : dim(14));

    const S = {
      root: { height: '100%', overflow: 'auto', padding: '18px 22px 36px', fontSize: '12.5px', lineHeight: '1.6' },
      // 布局：row = 一行里的若干东西（会换行）；between = 两端对齐的一行；grid = 会换行的卡片排。
      row: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
      between: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' },
      grid: { display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '16px' },
      // 字号层级：h1 页头 → h2 卡片标题 → sub 卡片内小标题 → num 大数字 → note/label 说明小字。
      h1: { fontSize: '16px', fontWeight: 600, lineHeight: '1.35' },
      h2: { fontSize: '13.5px', fontWeight: 600 },
      sub: { fontSize: '13px', fontWeight: 600, marginTop: '14px' },
      num: { fontSize: '19px', fontWeight: 600, lineHeight: '1.35' },
      lead: { fontSize: '12px', color: dim(62), marginTop: '2px' },
      label: { fontSize: '11.5px', color: dim(58) },
      note: { fontSize: '11.5px', color: dim(58), lineHeight: '1.55' },
      muted: { color: dim(55) },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      // 组件
      stat: { flex: '1 1 128px', minWidth: '128px', padding: '10px 13px', border: `1px solid ${dim(12)}`, borderRadius: '10px', background: dim(3) },
      card: { marginTop: '12px', padding: '13px 15px', border: `1px solid ${dim(13)}`, borderRadius: '10px' },
      head: { marginBottom: '10px' },
      segbar: { display: 'flex', flexWrap: 'wrap', gap: '2px', width: 'fit-content', maxWidth: '100%', marginTop: '18px', padding: '3px', border: `1px solid ${dim(12)}`, borderRadius: '999px', background: dim(4) },
      seg: { padding: '3px 12px', border: 'none', borderRadius: '999px', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px', lineHeight: '1.55', whiteSpace: 'nowrap' },
      segOn: { background: dim(14), fontWeight: 600, boxShadow: `inset 0 0 0 1px ${dim(18)}` },
      chip: (tone) => ({ display: 'inline-block', padding: '0 7px', borderRadius: '999px', fontSize: '11px', border: `1px solid ${toneBorder(tone)}`, color: toneColor(tone) }),
      table: { width: '100%', borderCollapse: 'collapse' },
      th: { textAlign: 'left', fontWeight: 500, color: dim(55), padding: '4px 8px 4px 0', borderBottom: `1px solid ${dim(14)}` },
      td: { padding: '4px 8px 4px 0', borderBottom: `1px solid ${dim(8)}`, verticalAlign: 'top' },
      pre: { margin: '6px 0 0', padding: '8px 10px', background: dim(6), borderRadius: '8px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      btn: { background: 'transparent', border: `1px solid ${dim(18)}`, borderRadius: '7px', color: 'inherit', cursor: 'pointer', padding: '2px 9px', fontSize: '11.5px' },
      input: { width: '100%', boxSizing: 'border-box', padding: '6px 9px', marginBottom: '8px', background: dim(5), border: `1px solid ${dim(16)}`, borderRadius: '8px', color: 'inherit', font: 'inherit' },
      entry: { padding: '9px 0', borderTop: `1px solid ${dim(9)}` },
      setRow: { display: 'flex', alignItems: 'baseline', gap: '10px', padding: '5px 0', borderTop: `1px solid ${dim(8)}` },
      // 专业键名的小字对照（只出现在「当前设置」卡里）：等宽 + 淡 + 一个细边药丸。
      kv: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '10.5px', color: dim(45), border: `1px solid ${dim(12)}`, borderRadius: '999px', padding: '0 5px', whiteSpace: 'nowrap' },
    };

    /**
     * 列表兜底（0.13.9）：不是数组就当空列表，数组里的非对象元素（null / 字符串）滤掉 ——
     * 渲染期读 `x.id` 抛异常 = 「记忆」页签整片白屏，只有人肉打开面板才看得见。
     */
    const objsOnly = (value) => (Array.isArray(value) ? value : []).filter((item) => item && typeof item === 'object');

    /**
     * 字符串清单兜底（0.13.9）：跟 objsOnly 同族，但只留字符串 —— 存**路径标签**的字段
     * （finding.files）不能过 objsOnly：那一版按「必须是对象」过滤，会把整条路径都扔光。
     */
    const strsOnly = (value) => (Array.isArray(value) ? value : []).filter((item) => typeof item === 'string');

    /** minScore 代价曲线最多显示 6 行（均匀抽样，首尾必留）；points 自己也过 objsOnly。 */
    const sampleCurve = (points) => {
      const list = objsOnly(points);
      if (list.length <= 6) return list;
      const step = (list.length - 1) / 5;
      const out = [];
      for (let i = 0; i < 6; i += 1) out.push(list[Math.round(i * step)]);
      return out;
    };

    /**
     * 显示层的数字净化（0.13.9）：进面板的数字先过这一道 —— 非有限数（NaN / Infinity /
     * 根本不是数字的东西）显示成「—」，而不是把账本里的脏值原样摊给用户看。
     * **只改显示、不动数据**：返回 null 表示「这个数不可信」。
     */
    const finiteNum = (value) => {
      // 超出安全整数范围的数也当不可信：`1e+21` 这种值不是「一个能被相信的计数」，
      // 面板里印出来只会让人以为真有其事。
      const ok = (n) => Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER;
      if (typeof value === 'number') return ok(value) ? value : null;
      if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return ok(n) ? n : null;
      }
      return null;
    };

    /** 数字 + 单位；不可信就只给「—」（单位也不跟，免得写成「— 条」）。 */
    const fmtNum = (value, unit = '') => {
      const n = finiteNum(value);
      return n === null ? '—' : `${n}${unit}`;
    };

    /**
     * 计数 + 单位：字段整个缺失时按 0 显示（老宿主没这个数，现状如此），
     * 但**有值却不可信**（NaN / Infinity）时给「—」—— 不把坏数字洗成 0（0.13.9）。
     */
    const fmtCount = (value, unit = '') => fmtNum(value === undefined || value === null ? 0 : value, unit);

    /** 比例 → 百分比文本；不可信就「—」（不假装 0%）。 */
    const fmtPct = (ratio, digits = 0) => {
      const n = finiteNum(ratio);
      return n === null ? '—' : `${(n * 100).toFixed(digits)}%`;
    };

    /** 毫秒 → 「12s」；不可信就「—」。 */
    const fmtSecs = (ms) => {
      const n = finiteNum(ms);
      return n === null ? '—' : `${Math.round(n / 1000)}s`;
    };

    /**
     * 宿主写来的人话里偶尔还夹着配置键名（判据句就是宿主拼的，如「抬 minScore 只会伤到自己」）。
     * 面板是给人看的，所以显示层再过一道：把键名换成人话词，别的字一个不动。
     * 只处理字符串；非字符串原样返回（数字/元素混进来时不该被当文案处理）。
     */
    const TERM_WORDS = [
      ['minScore', '相关度门槛'],
      ['maxChars', '字数上限'],
      ['maxPointers', '每次提醒条数'],
      ['collapsedIds', '缩掉的是哪几条'],
      ['usedCounted', '真正被读过的条数'],
      ['openRate', '被用上的比例'],
      ['budgetUse', '预算用量'],
      ['freeCap', '零代价上限'],
      ['legacy', '早期记录'],
      ['unaligned', '对不上号的旧记录'],
    ];
    const plainTerms = (text) => {
      if (typeof text !== 'string' || !text) return text;
      let out = text;
      for (const [key, word] of TERM_WORDS) out = out.split(key).join(word);
      // 换完留下的是「抬 相关度门槛 只会…」这种两侧空格（原文键名两侧本来有空格）：
      // 中文之间那一个空格去掉，读起来才是句子。
      return out.replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1');
    };

    /**
     * 三位开关：开 / 关 / —（不知道）。「关」和「不知道」是两回事（0.13.9）——
     * 以前这儿返回 on / off，那两个词面板上没人看得懂，现在直接给人话。
     */
    const fmtFlag = (value) => (value === undefined || value === null ? '—' : value ? '开' : '关');

    /**
     * 字节 → 人话。字段整个缺失按 0 显示（老宿主没这个数，现状如此），
     * 但**有值却不可信**时给「—」—— 跟 fmtCount 一个道理：不把坏数字洗成 0 B（0.13.9）。
     */
    const fmtBytes = (n) => {
      const v = n === undefined || n === null ? 0 : finiteNum(n);
      if (v === null) return '—';
      if (v < 1024) return `${v} B`;
      if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
      return `${(v / 1024 / 1024).toFixed(2)} MB`;
    };

    const fmtTime = (ms) => {
      const at = finiteNum(ms);
      const d = new Date(at ? at : Date.now());
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };

    /**
     * 原因码 → 人话。**与宿主侧 usage.js 的 REASON_LABELS 是同一份口径**（客户端 bundle
     * 只 require('react')，拿不到宿主模块，所以照抄一份）。
     */
    const REASON_LABELS = {
      chitchat: '寒暄 / 答话（设计如此）',
      'too-short': '消息太短',
      'empty-message': '空消息',
      duplicate: '与上一轮重复',
      'store-not-configured': '没配库路径',
      'index-empty': '库里没有笔记',
      'no-hits': '一条都不匹配',
      'below-min-score': '被相关度门槛拦住',
      unspecified: '没记原因（早期日志）',
    };

    /** 只在真·自家码上取值：`REASON_LABELS['constructor']` 这种原型链命中会让 React 拿到函数。 */
    const knownReason = (code) => (Object.prototype.hasOwnProperty.call(REASON_LABELS, code) ? REASON_LABELS[code] : null);

    /**
     * 日志里的 reason 有**两种**：宿主写的原因码（'too-short'）和人话句子
     * （'命令式提问，不需要回忆' / '索引 201 行' / '自动归档（触发：…）搬走 2 个批次'）。
     * 只翻认得出来的码；**长得像码**（纯小写英文 + 连字符）但没见过的，回落成人话，
     * 不把英文码摊到面板上；本来就是句子的原样留着。
     */
    const reasonText = (reason) => {
      const raw = typeof reason === 'string' ? reason.trim() : '';
      if (!raw) return '';
      const known = knownReason(raw);
      if (known) return known;
      return /^[a-z][a-z0-9-]*$/.test(raw) ? '原因未记（新版才有）' : raw;
    };

    /** 轮询宿主状态；失败不清空已有数据，只把错误挂出来（面板不该因一次抖动变白）。 */
    function useRecallState() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [at, setAt] = React.useState(0);
      const loadRef = React.useRef(() => {});

      React.useEffect(() => {
        let alive = true;
        const load = () => {
          fetch(STATE_URL, { headers: { accept: 'application/json' } })
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
            .then((data) => { if (alive) { setState(data); setError(null); setAt(Date.now()); } })
            .catch((err) => { if (alive) setError(String(err && err.message ? err.message : err)); });
        };
        loadRef.current = load;
        load();
        const timer = setInterval(load, POLL_MS);
        return () => { alive = false; clearInterval(timer); };
      }, []);

      // reload 给「归档」页签用：动完库要立刻看到新状态，不想干等下一次轮询。
      return { state, error, at, reload: () => loadRef.current() };
    }

    /* ══ 组件 ══════════════════════════════════════════════════════════════ */

    /** 概览卡：大字是结论，小字回答「这个数是什么、从哪来」。 */
    function Stat({ label, value, hint }) {
      return h('div', { style: S.stat },
        h('div', { style: S.label }, label),
        h('div', { style: S.num }, value),
        hint ? h('div', { style: { ...S.note, marginTop: '2px' } }, hint) : null);
    }

    /** 卡片壳：标题一句 + 解释一句 —— 日志、表格、曲线各归一张卡，别糊成一屏。 */
    function Card({ title, note, children }) {
      return h('section', { style: S.card },
        title || note
          ? h('div', { style: S.head },
            title ? h('div', { style: S.h2 }, title) : null,
            note ? h('div', { style: S.note }, note) : null)
          : null,
        children || null);
    }

    /** 「当前设置」里的一行：人话在左，值在右，专业键名当小字挂在最后（懂行的人对照用）。 */
    const settingRow = (label, value, key) => h('div', { key, style: S.setRow },
      h('span', { style: { flex: '1 1 auto' } }, label),
      h('span', { style: { whiteSpace: 'nowrap' } },
        h('span', { style: { fontWeight: 600 } }, value),
        h('span', { style: { ...S.kv, marginLeft: '7px' } }, key)));

    function LogEntry({ entry, expanded, onToggle }) {
      const kind = entry.kind;
      const tone = kind === 'hit' ? 'hit' : kind === 'skip' ? 'skip' : kind === 'deny' ? 'deny'
        : (kind === 'sediment' || kind === 'archive-auto') ? 'sediment' : 'note';
      const label = kind === 'hit' ? `提醒 ${fmtNum(entry.injected, ' 条')}`
        : kind === 'skip' ? '没提醒'
        : kind === 'deny' ? '拦下一个写入'
        : kind === 'deny-error' ? '写入保护出错'
        : kind === 'sediment' ? '问了句要不要记'
        : kind === 'archive-auto' ? '自动归档' : '没找到线索';
      // 0.13.9 起连元素一起兜：hits 不是数组、或数组里混了 null / 字符串，都当「没有明细」，
      // 不再读 hit.id 抛异常（渲染期抛异常 = 整片白屏）。
      const hits = objsOnly(entry.hits);
      const reason = reasonText(entry.reason);

      return h('div', { style: S.entry },
        h('div', { style: S.row },
          h('span', { style: { ...S.mono, ...S.muted, fontSize: '11px', whiteSpace: 'nowrap' } }, fmtTime(entry.at)),
          h('span', { style: S.chip(tone) }, label),
          h('span', { style: { flex: '1 1 220px', minWidth: '150px' } }, entry.query || '（空）'),
          kind === 'hit' ? h('span', { style: { ...S.mono, ...S.muted, fontSize: '11px', whiteSpace: 'nowrap' } }, fmtNum(entry.chars, ' 字')) : null,
          entry.nudge ? h('span', { style: S.chip('note') }, '顺带问了一句要不要记') : null,
          // 「提醒 5 条」却只列 4 条会被当成丢数据 —— 按钮上直接写清是「前 4 条」。
          hits.length ? h('button', { style: S.btn, onClick: onToggle }, expanded ? '收起' : (hits.length > 4 ? `展开全部 ${hits.length} 条` : '展开')) : null),
        hits.length ? h('div', { style: { ...S.row, gap: '4px 12px', marginTop: '4px' } },
          hits.slice(0, 4).map((hit, i) => h('span', {
            key: i,
            style: { ...S.mono, ...S.muted, fontSize: '11.5px' },
          }, `${hit.id}${hit.section ? ` § ${hit.section}` : ''} · ${fmtNum(hit.score)}`))) : null,
        hits.length > 4 && !expanded
          ? h('div', { style: { ...S.note, marginTop: '3px' } }, `上面是前 4 条，一共 ${hits.length} 条 —— 点「展开全部」看全。`)
          : null,
        reason ? h('div', { style: { ...S.note, marginTop: '3px' } },
          kind === 'skip' ? `没提醒的原因：${reason}` : reason) : null,
        expanded ? h('pre', { style: { ...S.pre, ...S.mono, fontSize: '11.5px' } },
          hits.map((hit, i) => `${i + 1}. ${hit.id}${hit.section ? ` § ${hit.section}` : ''}  score=${fmtNum(hit.score)}  ${fmtNum(hit.bytes, 'B')}`).join('\n')) : null);
    }

    function MemoryView() {
      const { state, error, at, reload } = useRecallState();
      const [tab, setTab] = React.useState('log');
      const [expanded, setExpanded] = React.useState(-1);
      const [filter, setFilter] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [results, setResults] = React.useState({});
      const [bulk, setBulk] = React.useState(null);

      if (!state) {
        return h('div', { style: S.root },
          h('div', null, '正在读取记忆库状态…'),
          error ? h('div', { style: { color: toneColor('note') } }, `宿主路由不可用：${error}`) : null);
      }

      // 列表类字段一律过 objsOnly：**非数组当空列表，数组里的非对象元素滤掉**。
      // 这四条都在页签分发**之前**被摸到（log 的统计累计、notes 的过滤器、findings 的
      // 严重性排序、writeAudit 的拦截计数），元素是 null 时它们直接抛 —— 那是七个页签
      // 一起白屏，连 return 都走不到（0.13.9）。
      const log = objsOnly(state.log);
      const notes = objsOnly(state.notes);
      const audit = state.audit || null;
      const findings = objsOnly(audit && audit.findings);
      // 摘要行的严重性计数：半截 summary（有 notes 没 bySeverity）不许把体检页签打成白屏。
      const sevCounts = (audit && audit.summary && audit.summary.bySeverity) || {};
      const SEV_ORDER = { error: 0, warn: 1, info: 2 };
      const SEV_COLOR = { error: toneColor('deny'), warn: toneColor('note'), info: dim(55) };
      const SEV_ICON = { error: '⛔', warn: '⚠️', info: 'ℹ️' };
      const sortedFindings = [...findings].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
      const totals = state.totals || { notes: 0, docs: 0, bytes: 0 };
      const index = state.index || { lines: 0, bytes: 0, text: '' };
      // 「不知道」和 0 是两回事：整块缺失（老宿主）回落成 0，块在但字段缺了印「—」，
      // 字段有值却不可信（NaN / 超安全整数）也印「—」。跟 0.13.9 那条防线一个口径。
      const numIn = (block, value, unit = '') => {
        if (!block) return fmtNum(0, unit);
        if (value === undefined || value === null) return '—';
        return fmtNum(value, unit);
      };
      const writeAudit = state.writeAudit || { epoch: '', entries: [] };
      const auditEntries = objsOnly(writeAudit.entries);
      const denied = auditEntries.filter((e) => e.verdict === 'deny').length;
      const archive = state.archive || { plans: [], skipped: [] };
      const plans = objsOnly(archive.plans);
      const archSkipped = objsOnly(archive.skipped);
      const stats = log.reduce((acc, item) => {
        acc[item.kind] = (acc[item.kind] || 0) + 1;
        if (item.kind === 'hit') acc.chars += Number(item.chars) || 0;
        return acc;
      }, { hit: 0, empty: 0, skip: 0, deny: 0, chars: 0 });
      // 落盘的使用账（宿主侧 summarizeUsage 的汇总 + 四句判据）。老宿主没这个字段就整块不显示。
      const usage = state.usage && typeof state.usage === 'object' ? state.usage : null;
    // 使用账的字段可能来自旧版宿主（少字段）或半截日志 —— 这一节用到什么就先补齐什么，
    // 别让一个属性访问或 toFixed 把整个「记忆」页签打成白屏（回归测试盯着这条）。
    const rounds = (usage && usage.perRound) || {};
    // 列表类字段统一过 objsOnly（0.13.9）：非数组当空列表、数组里的非对象元素滤掉。
    const positions = objsOnly(usage && usage.positions);
    const neverOpened = objsOnly(usage && usage.neverOpened);
    const openLag = (usage && usage.openLag) || null;
    // 设置卡回显用的 config：整块缺失（老宿主 / 半截快照）与「字段是 false」是两件事 —— 「不知道」不能写成「关」。
    const config = state.config && typeof state.config === 'object' ? state.config : null;
    const minScore = config ? finiteNum(config.minScore) : null;

      const shown = filter
        ? notes.filter((note) => `${note.file} ${note.title} ${note.description}`.toLowerCase().includes(filter.toLowerCase()))
        : notes;

      const tabBtn = (id, text) => h('button', {
        key: id,
        style: { ...S.seg, ...(tab === id ? S.segOn : {}) },
        onClick: () => setTab(id),
      }, text);

      // 两段式的第二段：计划是刚看的那个，执行前宿主还会现算一遍再核一次。
      // confirm:true 不是走过场 —— 宿主路由会拒掉没有它的请求。
      const archiveOne = (file) =>
        fetch(ARCHIVE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file, confirm: true }),
        })
          .then(async (res) => {
            let data;
            try {
              data = await res.json();
            } catch {
              data = { ok: false, reason: `HTTP ${res.status}（响应不是 JSON）` };
            }
            const good = res.ok && data.ok !== false;
            setResults((prev) => ({
              ...prev,
              [file]: good
                ? { ok: true, text: `已归档 → ${(data.historyFiles || []).join('、')}；原件备份在 ${data.backupDir}` }
                : { ok: false, text: String(data.reason || `HTTP ${res.status}`) },
            }));
            return good;
          })
          .catch((err) => {
            setResults((prev) => ({ ...prev, [file]: { ok: false, text: String((err && err.message) || err) } }));
            return false;
          });

      const runArchive = (file) => {
        setBusy(file);
        archiveOne(file).finally(() => {
          setBusy('');
          reload();
        });
      };

      // 「全部执行」：一篇一篇顺着来，不并发 —— 每篇都会重算一次计划、动一次库，
      // 并发只会让后一篇基于作废的计划去动库。失败不中断，剩下的照做，最后统一报数。
      const runAll = () => {
        setBusy(ALL);
        (async () => {
          let ok = 0;
          const failed = [];
          for (const plan of plans) {
            // eslint-disable-next-line no-await-in-loop
            if (await archiveOne(plan.file)) ok += 1;
            else failed.push(plan.file);
          }
          setBulk(
            failed.length
              ? { ok: false, text: `成功 ${ok} 篇，失败 ${failed.length} 篇：${failed.join('、')}` }
              : { ok: true, text: `全部 ${ok} 篇都归档完了。` },
          );
        })().finally(() => {
          setBusy('');
          reload();
        });
      };

      return h('div', { style: S.root },
        // ── 页头：这是什么 + 库在哪 + 什么时候读的 ──────────────────────────
        h('div', { style: S.between },
          h('div', null,
            h('div', { style: S.h1 }, '记忆库'),
            h('div', { style: S.lead }, '这一页摊开看：每一轮提醒了什么、后来有多少真的被用上。'),
            h('div', { style: { ...S.note, ...S.mono, marginTop: '2px' } }, state.store || '未配置记忆库路径')),
          h('div', { style: { ...S.note, whiteSpace: 'nowrap' } }, at ? `更新于 ${fmtTime(at)}` : '正在读取…')),
        error ? h('div', { style: { color: toneColor('note'), marginTop: '4px', fontSize: '11.5px' } }, `状态过期：${error}`) : null,

        // ── 概览：五张一眼能看懂的卡 ─────────────────────────────────────
        h('div', { style: S.grid },
          h(Stat, { label: '笔记', value: numIn(state.totals, totals.notes), hint: `${numIn(state.totals, totals.docs)} 个可检索片段` }),
          h(Stat, { label: '库大小', value: state.totals ? fmtBytes(totals.bytes) : fmtBytes(0), hint: '笔记加索引一起算' }),
          h(Stat, { label: '索引', value: numIn(state.index, index.lines, ' 行'), hint: `${state.index ? fmtBytes(index.bytes) : fmtBytes(0)} · 每次提醒前先读的小抄` }),
          h(Stat, {
            label: '给过提醒',
            value: stats.hit ? `${stats.hit} 轮` : '—',
            hint: stats.hit ? `最近 ${log.length} 轮里，共带出 ${fmtNum(stats.chars)} 字` : '最近这些轮都没提醒',
          }),
          h(Stat, {
            label: '写入保护',
            value: stats.deny ? `${stats.deny} 次` : '—',
            hint: stats.deny ? '挡下了会写坏库的改动' : '还没拦过',
          })),

        // ── 页签：分段控件，选中的那个有底 ───────────────────────────────
        h('div', { style: S.segbar },
          tabBtn('log', `提醒记录（${log.length}）`),
          // 「用上 4%」比裸的 4% 好懂：这是「提醒被用上的比例」。
          tabBtn('usage', usage && usage.pointers
            ? `使用情况（用上 ${fmtPct(usage.openRate ?? 0)}）`
            : '使用情况'),
          tabBtn('notes', `笔记（${notes.length}）`),
          tabBtn('audit', (() => {
            const b = audit && audit.summary && audit.summary.bySeverity;
            const n = b ? (b.error || 0) + (b.warn || 0) : 0;
            return n > 0 ? `自检（${n}）` : '自检';
          })()),
          tabBtn('index', '索引全文'),
          tabBtn('archive', plans.length ? `归档（${plans.length}）` : '归档'),
          tabBtn('writes', `写入记录（${auditEntries.length}）`)),

        // ── 提醒记录：每一轮给过什么、为什么没给 ─────────────────────────
        tab === 'log' ? h(Card, {
          title: '提醒记录',
          note: '最近 80 轮：哪一轮带了什么线索进来、后来有没有被用上。',
        },
          log.length
            ? log.map((entry, i) => h(LogEntry, {
              key: `${entry.at}-${i}`,
              entry,
              expanded: expanded === i,
              onToggle: () => setExpanded(expanded === i ? -1 : i),
            }))
            : h('div', { style: S.note }, '还没有记录：问答满一轮之后，这里就会多出一行。'))
          : null,

        // ── 使用情况：提醒有没有被用上 ───────────────────────────────────
        // 账本在库目录的 .engramory-recall.jsonl，算法与 `npm run recall:stats` 共用
        // （宿主侧 usage.js）；标签映射也照抄那一份。
        tab === 'usage' ? h(Card, {
          title: '使用情况',
          note: '给出去的提醒，后来有多少真的被用上 —— 这几个数决定每次该提醒几条。',
        },
          !usage ? h('div', { style: S.note },
            '宿主这一侧还没提供使用账 —— 重启一次 App（宿主代码不走热重载）后就有了。')
          : !usage.pointers ? h('div', { style: S.note },
              '还没有提醒记录。账本落在记忆库的 ',
              h('span', { style: S.mono }, '.engramory-recall.jsonl'),
              '，攒够 20 条再看这些比例更靠谱。')
          : h('div', null,
              h('div', { style: { ...S.grid, marginTop: 0 } },
                h(Stat, { label: '给过的提醒', value: fmtCount(usage.pointers, ' 条'), hint: `分 ${fmtCount(usage.injectRounds)} 轮给的` }),
                h(Stat, {
                  label: '被用上的比例',
                  // 缺字段（老宿主）按 0 显示，NaN 这种脏值给「—」—— 不假装 0%（0.13.9）。
                  value: fmtPct(usage.openRate ?? 0, 1),
                  hint: `${fmtCount(usage.usedCounted ?? usage.used)} 条真的被读过（一共 ${fmtCount(usage.used)} 次；同一轮读几遍只算一次）`,
                }),
                h(Stat, {
                  label: '提醒过的笔记',
                  value: fmtCount(usage.uniqueNotes, ' 篇'),
                  hint: neverOpened.length ? `${neverOpened.length} 篇一次都没被用上` : '每篇都至少被用上一次',
                }),
                h(Stat, {
                  label: '多久才被用上',
                  value: openLag && openLag.n ? fmtSecs(openLag.median) : '—',
                  hint: openLag && openLag.n ? `p90 ${fmtSecs(openLag.p90)} · n=${fmtNum(openLag.n)}` : '还没被用上过',
                })),

              // 分母要按「谁在问」拆开：子代理轮的提示词里没有「先看记忆库」这回事，
              // 把它们算进分母会把「被用上的比例」压低，而这个比例正是决定窗口宽窄的数。
              (() => {
                const scopes = usage.scopes || {};
                const label = { main: '你', subagent: '子代理', unknown: '没记是谁（旧记录）' };
                const rows = ['main', 'subagent', 'unknown']
                  .map((key) => [label[key], scopes[key]])
                  .filter(([, v]) => v && v.pointers);
                if (!rows.length) return null;
                return h('div', { style: { ...S.note, marginTop: '8px' } },
                  '谁在问：',
                  rows.map(([name, v], i) => h('span', { key: name },
                    i ? ' · ' : '',
                    // 半个桶（有 pointers 却没有轮数/用上数）用 fmtNum 印「—」：这里出现 0
                    // 会让人以为「真的没用上过」，而事实是宿主没给这个数（0.13.9 的纪律）。
                    `${name} ${fmtNum(v.injectRounds !== undefined ? v.injectRounds : v.rounds, ' 轮')} / ${fmtNum(v.pointers, ' 条')} / 用上 ${fmtNum(v.usedCounted !== undefined ? v.usedCounted : v.used)}（${fmtPct(v.openRate ?? 0, 1)}）`)));
              })(),

              h('div', { style: { fontSize: '11.5px', marginTop: '10px' } },
                [usage.verdicts && usage.verdicts.open, usage.verdicts && usage.verdicts.budget, usage.verdicts && usage.verdicts.truncation, usage.verdicts && usage.verdicts.reason, usage.verdicts && usage.verdicts.curve]
                  .filter(Boolean)
                  .map((v, i) => h('div', { key: i, style: S.muted }, `· ${plainTerms(v)}`))),

              usage.scoreCurve && usage.scoreCurve.n
                ? h('div', null,
                    h('div', { style: S.sub }, '抬高相关度门槛会付出什么'),
                    h('div', { style: S.note },
                      // 半截 scoreCurve（有 n 没 rounds）以前会把 undefined 写进句子 —— 全部过格式化（0.13.9）。
                      `配对 ${fmtNum(usage.scoreCurve.n)} 条提醒 / ${fmtNum(usage.scoreCurve.rounds)} 轮 —— 门槛一抬，先被砍掉的就是这几条。`),
                    h('table', { style: { ...S.table, marginTop: '4px' } },
                      h('thead', null, h('tr', null,
                        h('th', { style: S.th }, '相关度门槛'),
                        h('th', { style: S.th }, '还能留几条'),
                        h('th', { style: S.th }, '比现在少'),
                        h('th', { style: S.th }, '其中被用上过'))),
                      h('tbody', null,
                        sampleCurve(usage.scoreCurve.points || []).map((p, i) => h('tr', { key: i },
                          h('td', { style: { ...S.td, ...S.mono, whiteSpace: 'nowrap' } }, `≥ ${fmtNum(p.minScore)}`),
                          h('td', { style: S.td }, `留下 ${fmtNum(p.injected)}`),
                          h('td', { style: S.td }, `少 ${fmtPct(p.cutRate)}`),
                          h('td', { style: { ...S.td, ...(p.lost ? { color: toneColor('deny') } : {}) } }, `丢过 ${fmtNum(p.lost)}`))))))
                : null,

              h('div', { style: S.sub }, '第几条提醒会被用上'),
              h('div', { style: S.note },
                '第 N 条提醒被用上的比例 —— 尾巴长期是 0，就说明每次给得比需要的多。'),
              // 一行数据都没有时不摆空表：说明书留着，表头收起来，免得多出一行没内容的 tr。
              positions.some((p) => finiteNum(p.injected) > 0) ? h('table', { style: { ...S.table, marginTop: '4px' } },
                h('thead', null, h('tr', null,
                  h('th', { style: S.th }, '第几条'),
                  h('th', { style: S.th }, '用上 / 给过'),
                  h('th', { style: S.th }, '比例'),
                  h('th', { style: S.th }, ''))),
                h('tbody', null,
                  positions.filter((p) => finiteNum(p.injected) > 0).map((p, i) => {
                    const opened = finiteNum(p.opened);
                    const injected = finiteNum(p.injected);
                    const rate = opened === null || !injected ? null : opened / injected;
                    // 标签取桶自己的 position：过滤之后的下标会把数据挂到错的标签上（0.13.9）。
                    const pos = finiteNum(p.position);
                    return h('tr', { key: i },
                      h('td', { style: { ...S.td, whiteSpace: 'nowrap' } }, `第 ${pos === null ? i + 1 : pos} 条`),
                      h('td', { style: { ...S.td, ...S.mono } }, `${fmtNum(opened)}/${fmtNum(injected)}`),
                      h('td', { style: { ...S.td, ...S.mono, whiteSpace: 'nowrap' } },
                        rate === null ? '—' : fmtPct(rate)),
                      h('td', { style: { ...S.td, width: '45%' } },
                        h('div', { style: { height: '6px', borderRadius: '3px', background: dim(12), overflow: 'hidden' } },
                          h('div', {
                            style: {
                              height: '100%',
                              // 条形宽度是样式不是文字：坏数字按 0 宽画，别让 NaN% 变成非法 CSS。
                              width: `${Math.round((rate === null ? 0 : rate) * 100)}%`,
                              background: toneColor('hit'),
                            },
                          }))));
                  }))) : null,

              h('div', { style: S.sub }, '字数上限用掉了多少'),
              h('div', { style: { fontSize: '12px' } },
                rounds.median === undefined
                  ? '还没有逐轮记录（这一节要重启一次 App 让新宿主开始写）。'
                  // 半截 perRound（有 median、缺 min/p90/max）以前会漏出 undefined —— 缺的印「—」（0.13.9）。
                  : `每轮提醒 ${fmtNum(rounds.median)} 条（最少 ${fmtNum(rounds.min)} / p90 ${fmtNum(rounds.p90)} / 最多 ${fmtNum(rounds.max)}）`,
                rounds.windowLimit ? ` · 顶满窗口 ${fmtCount(rounds.fullRounds)}/${fmtCount(usage.injectRounds)} 轮` : '',
                rounds.median === undefined ? '' : ` · 有内容被截断 ${fmtCount(usage.truncatedRounds)} 轮（缩成只剩文件名 ${fmtCount(usage.collapsed)} 条、整条没列出 ${fmtCount(usage.dropped)} 条，涉及 ${fmtCount(usage.droppedRounds)} 轮）`),
              h('div', { style: S.note },
                usage.scoreStats && usage.scoreStats.n
                  ? `相关度分：中位 ${fmtNum(usage.scoreStats.median)} · p10 ${fmtNum(usage.scoreStats.p10)} · p90 ${fmtNum(usage.scoreStats.p90)} · 首尾落差中位 ${fmtNum(usage.scoreStats.spreadMedian)}（共 ${fmtCount(usage.scoreStats.n)} 轮）`
                  : '还没有带分数的提醒记录（早期日志没有 scores 字段）。'),
              h('div', { style: S.note },
                usage.budgetUse && usage.budgetUse.n
                  ? `字数上限用掉：中位 ${fmtPct(usage.budgetUse.median, 0)} · p90 ${fmtPct(usage.budgetUse.p90, 0)} · 顶到 95% 以上 ${fmtCount(usage.budgetUse.full)}/${fmtCount(usage.budgetUse.n)} 轮（要不要抬高上限，就看这一行）`
                  : '还没有字数用量记录（budget/spent 要 0.13.13 之后的宿主才写）。'),
              h('div', { style: S.note },
                // 截断的代价：被缩成只剩文件名的那几条后来被打开过吗（0.13.15 起落盘 collapsedIds）
                usage.truncation && usage.truncation.rounds
                  ? `截断的代价：被缩的 ${fmtCount(usage.truncation.collapsed.pointers, ' 条')}里被打开 ${fmtCount(usage.truncation.collapsed.opened)}（${fmtPct(usage.truncation.collapsed.openRate ?? 0, 1)}）· 完整列出的 ${fmtCount(usage.truncation.full.pointers, ' 条')}里 ${fmtCount(usage.truncation.full.opened)}（${fmtPct(usage.truncation.full.openRate ?? 0, 1)}）`
                  : '还没有「缩掉的是哪几条」的记录（要 0.13.15 之后落盘的宿主才写这一项）——所以「抬高上限值不值」还答不了。'),

              (usage.skipReasons && Object.keys(usage.skipReasons).length) || (usage.emptyReasons && Object.keys(usage.emptyReasons).length)
                ? h('div', null,
                    h('div', { style: S.sub }, '为什么没提醒'),
                    h('table', { style: { ...S.table, marginTop: '4px' } },
                      h('thead', null, h('tr', null,
                        h('th', { style: S.th }, '没提醒（' + fmtCount(usage.skipRounds, ' 轮') + '）'),
                        h('th', { style: S.th }, '次数'),
                        h('th', { style: S.th }, '一条都没匹配上（' + fmtCount(usage.emptyRounds, ' 轮') + '）'),
                        h('th', { style: S.th }, '次数'))),
                      h('tbody', null, (() => {
                        const left = Object.entries(usage.skipReasons || {});
                        const right = Object.entries(usage.emptyReasons || {});
                        const rows = Math.max(left.length, right.length);
                        return Array.from({ length: rows }, (_, i) => h('tr', { key: i },
                          h('td', { style: S.td }, left[i] ? reasonText(left[i][0]) : ''),
                          h('td', { style: { ...S.td, ...S.mono } }, left[i] ? fmtNum(left[i][1]) : ''),
                          h('td', { style: S.td }, right[i] ? reasonText(right[i][0]) : ''),
                          h('td', { style: { ...S.td, ...S.mono } }, right[i] ? fmtNum(right[i][1]) : '')));
                      })())))
                : null,

              neverOpened.length
                ? h('div', null,
                    h('div', { style: S.sub }, '提醒过，但从没被用上'),
                    h('div', { style: S.note },
                      '提醒了却没被用上 —— 要么那条不该提醒（词面太泛），要么它是被别的方式用掉了。'),
                    h('div', { style: { marginTop: '4px' } },
                      neverOpened.map((n, i) => h('div', {
                        key: i,
                        style: { ...S.row, gap: '8px', padding: '3px 0', borderTop: i ? `1px solid ${dim(8)}` : 'none' },
                      },
                        h('span', { style: { ...S.mono, fontSize: '11.5px' } }, n.id),
                        h('span', { style: { ...S.note, fontSize: '11px' } },
                          `提醒过 ${fmtCount(n.injected, ' 次')}${n.lastAt ? ` · 最近 ${fmtTime(n.lastAt)}` : ''}`)))))
                : null))
          : null,

        // ── 笔记 ────────────────────────────────────────────────────────
        tab === 'notes' ? h(Card, {
          title: '笔记',
          note: '记忆库里的每一篇；文件名、标题、描述都能搜。',
        },
          h('input', {
            value: filter,
            placeholder: '搜文件名 / 标题 / 描述',
            onChange: (event) => setFilter(event.target.value),
            style: { ...S.mono, ...S.input },
          }),
          shown.length ? null : h('div', { style: { ...S.note, marginBottom: '6px' } },
            notes.length
              ? `没有叫「${filter}」的笔记 —— 换个词试试。`
              : '这个库里还没有笔记：把一篇 .md 放进记忆库，它就会出现在这里。'),
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
                note.description ? h('div', { style: { ...S.note, fontSize: '11.5px' } }, note.description) : null),
              h('td', { style: { ...S.td, ...S.mono, textAlign: 'right', whiteSpace: 'nowrap' } }, fmtBytes(note.bytes)),
              h('td', { style: { ...S.td, ...S.mono, textAlign: 'right' } }, note.sections > 1 ? `${note.sections}` : '1'))))))
          : null,

        // ── 自检 ────────────────────────────────────────────────────────
        tab === 'audit' ? h(Card, {
          title: '自检',
          note: '看结构问题、失联路径和可疑重复 —— 有问题才列出来。',
        },
          audit && audit.summary
            ? h('div', { style: { ...S.note, marginBottom: '8px' } },
                // 计数走 fmtCount（跟别处一个规矩）：半截 summary 缺哪个字段就印 0，
                // 而不是 `undefined.error` 把体检页签打成白屏（0.13.9）。
                `${fmtCount(audit.summary.notes)} 篇笔记 · 结构错 ${fmtCount(sevCounts.error)} · 告警 ${fmtCount(sevCounts.warn)} · 提示 ${fmtCount(sevCounts.info)}`)
            : null,
          sortedFindings.length
            ? sortedFindings.map((f, i) => {
                // files 在契约里是**路径字符串数组**：不是数组就当没有清单（跟 hits 一个规矩），
                // 元素只留字符串 —— 以前直接 .join，宿主换个形状就是体检页签白屏（0.13.9）。
                const files = strsOnly(f.files);
                return h('div', {
                  key: `${f.code}-${i}`,
                  style: { padding: '7px 0', borderTop: i ? `1px solid ${dim(10)}` : 'none' },
                },
                  h('div', { style: { ...S.row, gap: '7px', alignItems: 'baseline' } },
                    h('span', null, SEV_ICON[f.severity] || '•'),
                    h('span', { style: { ...S.mono, fontSize: '10.5px', padding: '1px 6px', borderRadius: '999px', background: dim(8), border: `1px solid ${dim(16)}` } }, f.code),
                    h('span', { style: { color: SEV_COLOR[f.severity] || 'inherit' } }, f.message)),
                  files.length
                    ? h('div', { style: { ...S.note, ...S.mono, fontSize: '11px', marginTop: '3px', paddingLeft: '20px' } }, files.join('  ·  '))
                    : null);
              })
            : h('div', { style: S.note }, audit ? '✅ 没发现结构问题、失联路径或可疑重复。' : '还没拿到自检结果（宿主侧未就绪）。'))
          : null,

        // ── 写入记录 ────────────────────────────────────────────────────
        tab === 'writes' ? h(Card, {
          title: '写入记录',
          note: '每一次要动记忆库的写入：放行还是拦下、为什么。',
        },
          h('div', { style: { ...S.note, marginBottom: '8px' } },
            `规则版本 ${writeAudit.epoch || '—'} · 共 ${auditEntries.length} 条 · 拦截 ${denied} 条`),
          auditEntries.length
            ? auditEntries.map((entry, i) => h('div', {
                key: `${entry.ts}-${i}`,
                style: { padding: '7px 0', borderTop: i ? `1px solid ${dim(10)}` : 'none' },
              },
                h('div', { style: { ...S.row, gap: '8px', alignItems: 'baseline' } },
                  h('span', { style: { ...S.muted, ...S.mono, fontSize: '11px', whiteSpace: 'nowrap' } }, fmtTime(entry.ts)),
                  h('span', { style: S.chip(entry.verdict === 'deny' ? 'deny' : 'hit') }, entry.verdict === 'deny' ? '拦下' : '放行'),
                  h('span', { style: { ...S.mono, fontSize: '11px' } }, entry.tool || '?'),
                  h('span', { style: { ...S.mono, fontSize: '11.5px' } }, entry.file || '—'),
                  h('span', { style: { ...S.muted, ...S.mono, fontSize: '11px' } }, fmtBytes(entry.bytes || 0))),
                entry.reason ? h('div', { style: { color: toneColor('deny'), fontSize: '11.5px', marginTop: '3px', paddingLeft: '20px' } }, entry.reason) : null))
            : h('div', { style: S.note }, '还没有落在记忆库里的写入记录。审计从插件加载后开始记，写在 .engramory-audit.jsonl 里。'))
          : null,

        // ── 索引全文 ────────────────────────────────────────────────────
        tab === 'index' ? h(Card, {
          title: '索引全文',
          note: '每次提醒之前先读的那份小抄：一行一个指针。',
        },
          index.missing
            ? h('div', { style: S.note }, `没找到索引文件：${index.path}`)
            : h('pre', { style: { ...S.pre, ...S.mono, fontSize: '11.5px', maxHeight: '62vh' } }, index.text || '（空）'))
          : null,

        // ── 归档 ────────────────────────────────────────────────────────
        tab === 'archive' ? h(Card, {
          title: '归档',
          note: '把过长的旧章节整段搬去 <名字>-history.md，主文件只留结论和一行指针。',
        },
          h('div', { style: { ...S.note, marginBottom: '8px' } },
            '归档不删内容、也不截断，只搬追加式的「## 第 N 批」章节；搬运前先备份到 ',
            h('span', { style: S.mono }, '.archive-backup/<时间戳>/'),
            '。归档文件仍在同一个目录、仍会被索引和提醒；',
            h('span', { style: S.mono }, ' MEMORY.md 不动'),
            '——索引由另一套守卫管，且归档是机械派生、不是新事实。'),
          archive.crashed
            ? h('div', { style: { color: toneColor('deny'), marginBottom: '8px' } }, `归档规划崩了：${archive.crashed}`)
            : null,

          plans.length > 1
            ? h('div', { style: { ...S.row, gap: '8px', marginBottom: '4px' } },
                h('button', {
                  style: { ...S.btn, opacity: busy ? 0.5 : 1, fontWeight: 600 },
                  disabled: Boolean(busy),
                  onClick: runAll,
                }, busy === ALL ? `正在依次搬运 ${plans.length} 篇…` : `全部执行（${plans.length} 篇）`),
                h('span', { style: S.note }, '一篇一篇顺着来，失败不中断'))
            : null,

          plans.length
            ? plans.map((plan, i) => {
                const res = results[plan.file];
                const thisBusy = busy === plan.file || busy === ALL;
                return h('div', {
                  key: plan.file,
                  style: { padding: '9px 0', borderTop: i ? `1px solid ${dim(10)}` : 'none' },
                },
                  h('div', { style: { ...S.row, gap: '8px' } },
                    h('span', { style: { ...S.mono, fontSize: '11.5px' } }, plan.file),
                    h('span', { style: { ...S.muted, ...S.mono, fontSize: '11px' } },
                      `${fmtBytes(plan.bytes)} → ${fmtBytes(plan.keptBytes)}`),
                    h('span', { style: S.chip('hit') }, `省 ${fmtBytes(plan.savedBytes)}`),
                    h('button', {
                      style: { ...S.btn, opacity: thisBusy ? 0.5 : 1 },
                      disabled: thisBusy,
                      onClick: () => runArchive(plan.file),
                    }, busy === plan.file ? '搬运中…' : busy === ALL ? '排队中' : '执行归档')),
                  h('div', { style: { ...S.note, marginTop: '3px' } },
                    `${fmtNum(plan.batchCount)} 个批次章节，搬走 ${fmtNum(plan.freshCount)} 个 → `,
                    // 0.13.9 起 historyFiles 也过 objsOnly：宿主换成非数组形状不再整片白屏。
                    objsOnly(plan.historyFiles).map((hf) => `${hf.file}（${fmtNum(hf.batchCount)} 批 / ${fmtBytes(hf.bytes)}）`).join('、'),
                    plan.existingCount ? `（已有 ${fmtNum(plan.existingCount)} 份归档文件，续写）` : ''),
                  res ? h('div', {
                    style: { color: res.ok ? toneColor('hit') : toneColor('deny'), fontSize: '11.5px', marginTop: '3px' },
                  }, res.text) : null);
              })
            : h('div', { style: S.note },
                '没有超标的笔记。触发线：单篇 >64KB 或 >20 个章节，且至少 3 个可搬的批次章节。'),

          bulk
            ? h('div', {
                style: { color: bulk.ok ? toneColor('hit') : toneColor('note'), fontSize: '11.5px', marginTop: '8px' },
              }, bulk.text)
            : null,

          h('div', { style: { ...S.note, marginTop: '10px', paddingTop: '8px', borderTop: `1px solid ${dim(10)}` } },
            state.config?.autoArchive
              ? '自动归档已开启：每次写完记忆库后自动搬运，另有 10 分钟一次的兜底检查，每一步都进写入记录。'
              : '自动归档当前关闭——每次都要在这里点一下「执行归档」。想改成后台自动做，在插件配置里加 autoArchive: true。'),

          archSkipped.length
            ? h('div', { style: { ...S.note, marginTop: '10px', paddingTop: '8px', borderTop: `1px solid ${dim(10)}` } },
                `${archSkipped.length} 篇扫过但没到线：`,
                archSkipped.map((s) => `${s.file}（${s.reason}）`).join('；'))
            : null)
          : null,

        // ── 当前设置：人话在前，专业键名当小字对照 ───────────────────────
        // 面板要能回答「现在到底按哪套参数在提醒」。
        // 0.13.9 起：整块缺失就明说「配置未回显」，半截时缺的字段印「—」，只有真拿到 false 才写「关」——
        // 「关」和「不知道」是两回事（以前是 undefined / off，等于替宿主撒谎）。
        h(Card, { title: '当前设置', note: '插件现在按这套参数工作；灰色小字是配置文件里的原字段名。' },
          !config
            ? h('div', { style: S.note }, '配置未回显（宿主这一侧的 state 里没有 config）—— 重启一次 App 再看。')
            : h('div', null,
                settingRow('记忆功能总开关', fmtFlag(config.enabled), 'enabled'),
                settingRow('每次最多提醒几条', fmtNum(config.maxPointers, ' 条'), 'maxPointers'),
                settingRow('一轮提醒的字数上限', fmtNum(config.maxChars, ' 字'), 'maxChars'),
                settingRow('相关度门槛', minScore === null ? '—' : minScore > 0 ? `${minScore} 分以上才提醒` : '0（不过滤，沾边就提醒）', 'minScore'),
                settingRow('做完事顺带问一句「要不要记一笔」', fmtFlag(config.nudge), 'nudge'),
                settingRow('写入保护', fmtFlag(config.guardWrites), 'guardWrites'),
                settingRow('自动归档', fmtFlag(config.autoArchive), 'autoArchive'))));
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
