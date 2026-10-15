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
    const ARCHIVE_URL = '/api/engramory-recall/archive';
    /** busy 的哨兵值：正在跑「全部执行」，此时所有单篇按钮都该禁用。 */
    const ALL = '@all';
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

    /** 数字 + 单位；不可信就只给「—」。 */
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

    /** 三位开关：on / off / —（不知道）。「关」和「不知道」是两回事（0.13.9）。 */
    const fmtFlag = (value) => (value === undefined || value === null ? '—' : value ? 'on' : 'off');

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
     * 只 require('react')，拿不到宿主模块，所以照抄一份）；出现没列过的码就原样显示，
     * 别把新码藏起来 —— 那正是「为什么没注入」最该被看见的时候。
     */
    const REASON_LABELS = {
      chitchat: '寒暄 / 答话（设计如此）',
      'too-short': '消息太短',
      'empty-message': '空消息',
      duplicate: '与上一轮重复',
      'store-not-configured': '没配库路径',
      'index-empty': '库里没有笔记',
      'no-hits': '一条都不匹配',
      'below-min-score': '被 minScore 拦住',
      unspecified: '没记原因（早期日志）',
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

    function Stat({ label, value, hint }) {
      return h('div', { style: { minWidth: '104px' } },
        h('div', { style: S.muted }, label),
        h('div', { style: { ...S.mono, fontSize: '15px' } }, value),
        hint ? h('div', { style: { ...S.muted, fontSize: '11px' } }, hint) : null);
    }

    function LogEntry({ entry, expanded, onToggle }) {
      const tone = entry.kind === 'hit' ? 'hit' : entry.kind === 'skip' ? 'skip' : entry.kind === 'deny' ? 'deny' : (entry.kind === 'sediment' || entry.kind === 'archive-auto') ? 'sediment' : 'empty';
      const label = entry.kind === 'hit' ? `注入 ${fmtNum(entry.injected, ' 条')}`
        : entry.kind === 'skip' ? '跳过'
        : entry.kind === 'deny' ? '拦截写入'
        : entry.kind === 'deny-error' ? '闸门异常'
        : entry.kind === 'sediment' ? '沉淀提醒'
        : entry.kind === 'archive-auto' ? '自动归档' : '无命中';
      // 0.13.9 起连元素一起兜：hits 不是数组、或数组里混了 null / 字符串，都当「没有明细」，
      // 不再读 hit.id 抛异常（渲染期抛异常 = 整片白屏）。
      const hits = objsOnly(entry.hits);

      return h('div', { style: { padding: '7px 0', borderBottom: `1px solid ${dim(8)}` } },
        h('div', { style: S.row },
          h('span', { style: { ...S.mono, ...S.muted } }, fmtTime(entry.at)),
          h('span', { style: S.chip(tone) }, label),
          h('span', { style: { flex: '1 1 240px', minWidth: '180px' } }, entry.query || '（空）'),
          entry.kind === 'hit' ? h('span', { style: { ...S.muted, ...S.mono } }, fmtNum(entry.chars, ' 字符')) : null,
          entry.nudge ? h('span', { style: S.chip('empty') }, '含记忆提示') : null,
          hits.length ? h('button', { style: S.btn, onClick: onToggle }, expanded ? '收起' : '展开') : null),
        hits.length ? h('div', { style: { ...S.row, marginTop: '3px' } },
          hits.slice(0, 4).map((hit, i) => h('span', {
            key: i,
            style: { ...S.mono, ...S.muted, fontSize: '11.5px' },
          }, `${hit.id}${hit.section ? ` § ${hit.section}` : ''} · ${fmtNum(hit.score)}`))) : null,
        entry.reason ? h('div', { style: { ...S.muted, fontSize: '11.5px', marginTop: '4px' } }, entry.reason) : null,
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
          error ? h('div', { style: { color: '#c2803a' } }, `宿主路由不可用：${error}`) : null);
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
      const SEV_COLOR = { error: '#c25a4a', warn: '#c2803a', info: dim(55) };
      const SEV_ICON = { error: '⛔', warn: '⚠️', info: 'ℹ️' };
      const sortedFindings = [...findings].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
      const totals = state.totals || { notes: 0, docs: 0, bytes: 0 };
      const index = state.index || { lines: 0, bytes: 0, text: '' };
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
    // 页脚回显用的 config：整块缺失（老宿主 / 半截快照）与「字段是 false」是两件事 —— 「不知道」不能写成「关」。
    const config = state.config && typeof state.config === 'object' ? state.config : null;

      const shown = filter
        ? notes.filter((note) => `${note.file} ${note.title} ${note.description}`.toLowerCase().includes(filter.toLowerCase()))
        : notes;

      const tabBtn = (id, text) => h('button', {
        key: id,
        style: { ...S.btn, borderColor: tab === id ? dim(45) : dim(18), fontWeight: tab === id ? 600 : 400 },
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
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('div', { style: S.row },
            h('span', { style: S.title && { fontSize: '13px', fontWeight: 600 } }, 'Engramory 记忆库'),
            h('span', { style: { ...S.muted, ...S.mono, fontSize: '11.5px' } }, state.store || '未配置')),
          h('span', { style: { ...S.muted, fontSize: '11px' } }, at ? `更新于 ${fmtTime(at)}` : '')),
        error ? h('div', { style: { color: '#c2803a', marginTop: '4px' } }, `状态过期：${error}`) : null,

        h('div', { style: { ...S.row, gap: '22px', marginTop: '12px' } },
          h(Stat, { label: '笔记', value: fmtNum(totals.notes), hint: fmtNum(totals.docs, ' 个检索片段') }),
          h(Stat, { label: '库大小', value: fmtBytes(totals.bytes) }),
          h(Stat, { label: '索引', value: fmtNum(index.lines, ' 行'), hint: fmtBytes(index.bytes) }),
          h(Stat, { label: '本轮注入', value: stats.hit ? `${stats.hit} 次` : '—', hint: stats.chars ? `共 ${fmtNum(stats.chars)} 字符` : '尚无命中' }),
          h(Stat, { label: '闸门拦截', value: stats.deny ? `${stats.deny} 次` : '—', hint: stats.deny ? '写记忆库被拒' : '尚无拦截' })),

        h('div', { style: { ...S.row, gap: '6px', marginTop: '16px' } },
          tabBtn('log', `召回日志（${log.length}）`),
          tabBtn('usage', usage && usage.pointers
            ? `使用账（${fmtPct(usage.openRate ?? 0)}）`
            : '使用账'),
          tabBtn('notes', `笔记（${notes.length}）`),
          tabBtn('audit', (() => {
            const b = audit && audit.summary && audit.summary.bySeverity;
            const n = b ? (b.error || 0) + (b.warn || 0) : 0;
            return n > 0 ? `体检（${n}）` : '体检';
          })()),
          tabBtn('index', '索引原文'),
          tabBtn('archive', plans.length ? `归档（${plans.length}）` : '归档'),
          tabBtn('writes', `写入审计（${auditEntries.length}）`)),

        tab === 'log' ? h('div', { style: S.card },
          log.length ? log.map((entry, i) => h(LogEntry, {
            key: `${entry.at}-${i}`,
            entry,
            expanded: expanded === i,
            onToggle: () => setExpanded(expanded === i ? -1 : i),
          })) : h('div', { style: S.muted }, '这个会话还没有召回记录。发一句真实的提问就会出现在这里。'))
          : null,

        // 使用账：注入的指针对后来有没有被打开。账本在库目录的 .engramory-recall.jsonl，
        // 算法与 `npm run recall:stats` 共用（宿主侧 usage.js）；标签映射也照抄那一份。
        tab === 'usage' ? h('div', { style: S.card },
          !usage ? h('div', { style: S.muted },
            '宿主这一侧还没提供使用账 —— 重启一次 App（宿主代码不走热重载）后就有了。')
          : !usage.pointers ? h('div', { style: S.muted },
              '还没有注入记录。账本落在记忆库的 ',
              h('span', { style: S.mono }, '.engramory-recall.jsonl'),
              '，攒够 20 条指针再回来看判据。')
          : h('div', null,
              h('div', { style: { ...S.row, gap: '20px', alignItems: 'flex-start' } },
                h(Stat, { label: '注入指针', value: fmtCount(usage.pointers, ' 条'), hint: fmtCount(usage.injectRounds, ' 轮') }),
                h(Stat, {
                  label: '打开率',
                  // 缺字段（老宿主）按 0 显示，NaN 这种脏值给「—」—— 不假装 0%（0.13.9）。
                  value: fmtPct(usage.openRate ?? 0, 1),
                  hint: `${fmtCount(usage.usedCounted ?? usage.used)} 条被 read/edit（去重后；共 ${fmtCount(usage.used)} 次）`,
                }),
                h(Stat, {
                  label: '注入过的笔记',
                  value: fmtCount(usage.uniqueNotes, ' 篇'),
                  hint: neverOpened.length ? `${neverOpened.length} 篇从未被打开` : '都至少打开过一次',
                }),
                h(Stat, {
                  label: '打开延迟',
                  value: openLag && openLag.n ? fmtSecs(openLag.median) : '—',
                  hint: openLag && openLag.n ? `p90 ${fmtSecs(openLag.p90)} · n=${fmtNum(openLag.n)}` : '还没被打开过',
                })),

              // 分母要按「谁在问」拆开：委派轮（子代理）的提示词里没有「先看记忆库」这回事，
              // 把它们算进分母会把打开率压低，而打开率正是决定窗口宽窄的那个数。
              (() => {
                const scopes = usage.scopes || {};
                const label = { main: '主对话轮', subagent: '子代理轮', unknown: '未标记（0.13.7 前）' };
                const rows = ['main', 'subagent', 'unknown']
                  .map((key) => [label[key], scopes[key]])
                  .filter(([, v]) => v && v.pointers);
                if (!rows.length) return null;
                return h('div', { style: { ...S.muted, fontSize: '11.5px', marginTop: '8px' } },
                  '按提问者：',
                  rows.map(([name, v], i) => h('span', { key: name },
                    i ? ' · ' : '',
                    `${name} ${fmtCount(v.injectRounds, ' 轮')} / ${fmtCount(v.pointers, ' 条')} / 打开 ${fmtCount(v.used)}（${fmtPct(v.openRate ?? 0, 1)}）`)));
              })(),

              h('div', { style: { fontSize: '11.5px', marginTop: '10px' } },
                [usage.verdicts && usage.verdicts.open, usage.verdicts && usage.verdicts.budget, usage.verdicts && usage.verdicts.truncation, usage.verdicts && usage.verdicts.reason, usage.verdicts && usage.verdicts.curve]
                  .filter(Boolean)
                  .map((v, i) => h('div', { key: i, style: S.muted }, `· ${v}`))),

              usage.scoreCurve && usage.scoreCurve.n
                ? h('div', null,
                    h('div', { style: S.title }, '把 minScore 抬高会付出什么'),
                    h('div', { style: { ...S.muted, fontSize: '11.5px' } },
                      // 半截 scoreCurve（有 n 没 rounds）以前会把 undefined 写进句子 —— 全部过格式化（0.13.9）。
                      `配对 ${fmtNum(usage.scoreCurve.n)} 条指针 / ${fmtNum(usage.scoreCurve.rounds)} 轮 —— 「其中被打开过的」那一列就是代价。`),
                    h('table', { style: { ...S.table, marginTop: '4px' } },
                      h('tbody', null,
                        sampleCurve(usage.scoreCurve.points || []).map((p, i) => h('tr', { key: i },
                          h('td', { style: { ...S.td, ...S.mono, whiteSpace: 'nowrap' } }, `≥ ${fmtNum(p.minScore)}`),
                          h('td', { style: S.td }, `留下 ${fmtNum(p.injected)}`),
                          h('td', { style: S.td }, `砍 ${fmtPct(p.cutRate)}`),
                          h('td', { style: { ...S.td, ...(p.lost ? { color: 'var(--danger, #d33)' } : {}) } }, `丢过 ${fmtNum(p.lost)}`)))))) 
                : null,

              h('div', { style: S.title }, '位置级曲线'),
              h('div', { style: { ...S.muted, fontSize: '11.5px' } },
                '第 N 条指针被打开的比例 —— 尾部长期是 0，说明窗口比需要的大。'),
              h('table', { style: { ...S.table, marginTop: '4px' } },
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
                              background: '#2e9e63',
                            },
                          }))));
                  }))),

              h('div', { style: S.title }, '预算与分数'),
              h('div', { style: { fontSize: '12px' } },
                rounds.median === undefined
                  ? '还没有逐轮记录（这一节要重启一次 App 让新宿主开始写）。'
                  // 半截 perRound（有 median、缺 min/p90/max）以前会漏出 undefined —— 缺的印「—」（0.13.9）。
                  : `每轮注入 ${fmtNum(rounds.median)} 条（最少 ${fmtNum(rounds.min)} / p90 ${fmtNum(rounds.p90)} / 最多 ${fmtNum(rounds.max)}）`,
                rounds.windowLimit ? ` · 顶满窗口 ${fmtCount(rounds.fullRounds)}/${fmtCount(usage.injectRounds)} 轮` : '',
                rounds.median === undefined ? '' : ` · 有内容被截断 ${fmtCount(usage.truncatedRounds)} 轮（缩成裸文件名 ${fmtCount(usage.collapsed)} 条、整条没列出 ${fmtCount(usage.dropped)} 条，涉及 ${fmtCount(usage.droppedRounds)} 轮）`),
              h('div', { style: { ...S.muted, fontSize: '11.5px', marginTop: '2px' } },
                usage.scoreStats && usage.scoreStats.n
                  ? `注入分：中位 ${fmtNum(usage.scoreStats.median)} · p10 ${fmtNum(usage.scoreStats.p10)} · p90 ${fmtNum(usage.scoreStats.p90)} · 首尾落差中位 ${fmtNum(usage.scoreStats.spreadMedian)}（共 ${fmtCount(usage.scoreStats.n)} 轮）`
                  : '还没有带分数的注入记录（早期日志没有 scores 字段）。'),
              h('div', { style: { ...S.muted, fontSize: '11.5px' } },
                usage.budgetUse && usage.budgetUse.n
                  ? `预算用掉：中位 ${fmtPct(usage.budgetUse.median, 0)} · p90 ${fmtPct(usage.budgetUse.p90, 0)} · 顶到 95% 以上 ${fmtCount(usage.budgetUse.full)}/${fmtCount(usage.budgetUse.n)} 轮（抬不抬 maxChars 就看这一行）`
                  : '还没有预算用量记录（budget/spent 要 0.13.13 之后的宿主才写）。'),
              h('div', { style: { ...S.muted, fontSize: '11.5px' } },
                // 截断的代价：被缩成裸文件名的那几条后来被打开过吗（0.13.15 起落盘 collapsedIds）
                usage.truncation && usage.truncation.rounds
                  ? `截断的代价：被缩的 ${fmtCount(usage.truncation.collapsed.pointers, ' 条')}里被打开 ${fmtCount(usage.truncation.collapsed.opened)}（${fmtPct(usage.truncation.collapsed.openRate ?? 0, 1)}）· 完整列出的 ${fmtCount(usage.truncation.full.pointers, ' 条')}里 ${fmtCount(usage.truncation.full.opened)}（${fmtPct(usage.truncation.full.openRate ?? 0, 1)}）`
                  : '还没有「缩掉的是哪几条」的记录（collapsedIds 要 0.13.15 之后的宿主才写）——所以「抬 maxChars 值不值」还答不了。'),

              (usage.skipReasons && Object.keys(usage.skipReasons).length) || (usage.emptyReasons && Object.keys(usage.emptyReasons).length)
                ? h('div', null,
                    h('div', { style: S.title }, '为什么没注入'),
                    h('table', { style: { ...S.table, marginTop: '4px' } },
                      h('thead', null, h('tr', null,
                        h('th', { style: S.th }, '跳过（' + fmtCount(usage.skipRounds, ' 轮') + '）'),
                        h('th', { style: S.th }, '次数'),
                        h('th', { style: S.th }, '零命中（' + fmtCount(usage.emptyRounds, ' 轮') + '）'),
                        h('th', { style: S.th }, '次数'))),
                      h('tbody', null, (() => {
                        const left = Object.entries(usage.skipReasons || {});
                        const right = Object.entries(usage.emptyReasons || {});
                        const rows = Math.max(left.length, right.length);
                        return Array.from({ length: rows }, (_, i) => h('tr', { key: i },
                          h('td', { style: S.td }, left[i] ? REASON_LABELS[left[i][0]] || left[i][0] : ''),
                          h('td', { style: { ...S.td, ...S.mono } }, left[i] ? fmtNum(left[i][1]) : ''),
                          h('td', { style: S.td }, right[i] ? REASON_LABELS[right[i][0]] || right[i][0] : ''),
                          h('td', { style: { ...S.td, ...S.mono } }, right[i] ? fmtNum(right[i][1]) : '')));
                      })())))
                : null,

              neverOpened.length
                ? h('div', null,
                    h('div', { style: S.title }, '注入过、但从没被打开'),
                    h('div', { style: { ...S.muted, fontSize: '11.5px' } },
                      '注入了却没被用上 —— 要么那条不该注入（词面太泛），要么它是被别的方式用掉了。'),
                    h('div', { style: { marginTop: '4px' } },
                      neverOpened.map((n, i) => h('div', {
                        key: i,
                        style: { ...S.row, gap: '8px', padding: '3px 0', borderTop: i ? `1px solid ${dim(8)}` : 'none' },
                      },
                        h('span', { style: { ...S.mono, fontSize: '11.5px' } }, n.id),
                        h('span', { style: { ...S.muted, fontSize: '11px' } },
                          `注入 ${fmtCount(n.injected, ' 次')}${n.lastAt ? ` · 最近 ${fmtTime(n.lastAt)}` : ''}`)))))
                : null))
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
                    ? h('div', { style: { ...S.muted, ...S.mono, fontSize: '11px', marginTop: '3px', paddingLeft: '20px' } }, files.join('  ·  '))
                    : null);
              })
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

        tab === 'archive' ? h('div', { style: S.card },
          h('div', { style: { ...S.muted, fontSize: '11.5px', marginBottom: '8px' } },
            '归档不删内容、也不截断：把追加式的「## 第 N 批」章节整段搬到 ',
            h('span', { style: S.mono }, '<名字>-history.md'),
            '，主文件只留结论和一行指针。搬运前先备份到 ',
            h('span', { style: S.mono }, '.archive-backup/<时间戳>/'),
            '；归档文件仍在同一个目录、仍会被索引和召回。',
            h('span', { style: { ...S.mono } }, ' MEMORY.md 不动'),
            '——索引由另一套守卫管，且归档是机械派生、不是新事实。'),
          archive.crashed
            ? h('div', { style: { color: '#c25a4a', marginBottom: '8px' } }, `归档规划崩了：${archive.crashed}`)
            : null,

          plans.length > 1
            ? h('div', { style: { ...S.row, gap: '8px', marginBottom: '4px' } },
                h('button', {
                  style: { ...S.btn, opacity: busy ? 0.5 : 1, fontWeight: 600 },
                  disabled: Boolean(busy),
                  onClick: runAll,
                }, busy === ALL ? `正在依次搬运 ${plans.length} 篇…` : `全部执行（${plans.length} 篇）`),
                h('span', { style: { ...S.muted, fontSize: '11.5px' } }, '一篇一篇顺着来，失败不中断'))
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
                  h('div', { style: { ...S.muted, fontSize: '11.5px', marginTop: '3px' } },
                    `${fmtNum(plan.batchCount)} 个批次章节，搬走 ${fmtNum(plan.freshCount)} 个 → `,
                    // 0.13.9 起 historyFiles 也过 objsOnly：宿主换成非数组形状不再整片白屏。
                    objsOnly(plan.historyFiles).map((hf) => `${hf.file}（${fmtNum(hf.batchCount)} 批 / ${fmtBytes(hf.bytes)}）`).join('、'),
                    plan.existingCount ? `（已有 ${fmtNum(plan.existingCount)} 份归档文件，续写）` : ''),
                  res ? h('div', {
                    style: { color: res.ok ? '#2e9e63' : '#d24b4b', fontSize: '11.5px', marginTop: '3px' },
                  }, res.text) : null);
              })
            : h('div', { style: S.muted },
                '没有超标的笔记。触发线：单篇 >64KB 或 >20 个章节，且至少 3 个可搬的批次章节。'),

          bulk
            ? h('div', {
                style: { color: bulk.ok ? '#2e9e63' : '#c2803a', fontSize: '11.5px', marginTop: '8px' },
              }, bulk.text)
            : null,

          h('div', { style: { ...S.muted, fontSize: '11px', marginTop: '10px', paddingTop: '8px', borderTop: `1px solid ${dim(10)}` } },
            state.config?.autoArchive
              ? '自动归档已开启：每次写完记忆库后自动搬运，另有 10 分钟一次的兜底检查，每一步都进写入审计。'
              : '自动归档当前关闭——每次都要在这里点一下「执行归档」。想改成后台自动做，在插件配置里加 autoArchive: true。'),

          archSkipped.length
            ? h('div', { style: { ...S.muted, fontSize: '11px', marginTop: '10px', paddingTop: '8px', borderTop: `1px solid ${dim(10)}` } },
                `${archSkipped.length} 篇扫过但没到线：`,
                archSkipped.map((s) => `${s.file}（${s.reason}）`).join('；'))
            : null)
          : null,

        // 配置回显：面板要能回答「现在到底按哪套参数在召回」。
        // 0.13.9 起：整块缺失就明说「配置未回显」，半截时缺的字段印「—」，只有真拿到 falsy 才写 off ——
        // 「关」和「不知道」是两回事（以前是 undefined / off，等于替宿主撒谎）。
        h('div', { style: { ...S.muted, marginTop: '14px', ...S.mono, fontSize: '11px' } },
          !config
            ? '配置未回显（宿主这一侧的 state 里没有 config）—— 重启一次 App 再看。'
            : `maxPointers=${fmtNum(config.maxPointers)} maxChars=${fmtNum(config.maxChars)} ` +
              `minScore=${fmtNum(config.minScore)} nudge=${fmtFlag(config.nudge)} ` +
              `guardWrites=${fmtFlag(config.guardWrites)} ` +
              `autoArchive=${fmtFlag(config.autoArchive)} ` +
              `enabled=${fmtFlag(config.enabled)}`));
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
