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
    /**
     * 状态色。原色在浅色主题下当小字用是不达标的（实测绿 3.39:1、橙 3.26:1、红 4.17:1，
     * AA 要 4.5:1）—— 所以一律和 currentColor 混一道：浅色主题变深、深色主题变亮，
     * 一份色表同时管两种主题，不用theme 分支。
     */
    const TONE = { hit: '#2e9e63', deny: '#d24b4b', sediment: '#3d7bbf', note: '#c2803a', skip: null, unknown: null };
    const mixTone = (tone, pct) => `color-mix(in srgb, ${TONE[tone]} ${pct}%, currentColor)`;
    // 未知态用 dim(70)：dim(55) 在白底上只有 3.74:1，小字不达标（Lead 用浏览器实测过对比度）。
    const toneColor = (tone) => (TONE[tone] === undefined ? TONE.note : (TONE[tone] ? mixTone(tone, 70) : dim(70)));
    const toneBorder = (tone) => (TONE[tone] ? mixTone(tone, 55) : dim(14));

    const S = {
      root: { height: '100%', overflow: 'auto', padding: '18px 22px 36px', fontSize: '12.5px', lineHeight: '1.6' },
      // 布局：row = 一行里的若干东西（会换行）；between = 两端对齐的一行；grid = 会换行的卡片排。
      row: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
      between: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' },
      grid: { display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '16px' },
      // 字号层级：h1 页头 → q 首屏的问题 → h2 卡片标题 → sub 卡片内小标题 → num 大数字 → note/label 说明小字。
      h1: { fontSize: '16px', fontWeight: 600, lineHeight: '1.35' },
      h2: { fontSize: '13.5px', fontWeight: 600 },
      // 首屏三问的问题标题：比卡片标题大一档 —— 它是一屏的主语，不是装饰。
      q: { fontSize: '14.5px', fontWeight: 600, lineHeight: '1.4' },
      sub: { fontSize: '13px', fontWeight: 600, marginTop: '14px' },
      num: { fontSize: '19px', fontWeight: 600, lineHeight: '1.35' },
      lead: { fontSize: '12px', color: dim(70), marginTop: '2px' },
      label: { fontSize: '11.5px', color: dim(70) },
      note: { fontSize: '11.5px', color: dim(70), lineHeight: '1.55' },
      muted: { color: dim(66) },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      // 组件
      stat: { flex: '1 1 128px', minWidth: '128px', padding: '10px 13px', border: `1px solid ${dim(12)}`, borderRadius: '10px', background: dim(3) },
      card: { marginTop: '12px', padding: '13px 15px', border: `1px solid ${dim(13)}`, borderRadius: '10px' },
      // 首屏三问：用**细线 + 留白**分隔，不用三张同规格的卡 —— 同规格的卡会把
      // 「一份清单 / 一条趋势 / 一行状态」压成三个仪表盘格子，问题反而看不清了。
      ask: { marginTop: '22px', paddingTop: '16px', borderTop: `1px solid ${dim(14)}` },
      // 清单里的一行（首屏的最新一轮、日志里的指针）：靠基线对齐，不靠盒模型。
      line: { display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '3px 0' },
      head: { marginBottom: '10px' },
      segbar: { display: 'flex', flexWrap: 'wrap', gap: '2px', width: 'fit-content', maxWidth: '100%', marginTop: '18px', padding: '3px', border: `1px solid ${dim(12)}`, borderRadius: '999px', background: dim(4) },
      seg: { padding: '3px 12px', border: 'none', borderRadius: '999px', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px', lineHeight: '1.55', whiteSpace: 'nowrap' },
      segOn: { background: dim(14), fontWeight: 600, boxShadow: `inset 0 0 0 1px ${dim(18)}` },
      chip: (tone) => ({ display: 'inline-block', padding: '0 7px', borderRadius: '999px', fontSize: '11px', border: `1px solid ${toneBorder(tone)}`, color: toneColor(tone) }),
      table: { width: '100%', borderCollapse: 'collapse' },
      th: { textAlign: 'left', fontWeight: 500, color: dim(66), padding: '4px 8px 4px 0', borderBottom: `1px solid ${dim(14)}` },
      td: { padding: '4px 8px 4px 0', borderBottom: `1px solid ${dim(8)}`, verticalAlign: 'top' },
      pre: { margin: '6px 0 0', padding: '8px 10px', background: dim(6), borderRadius: '8px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      btn: { background: 'transparent', border: `1px solid ${dim(18)}`, borderRadius: '7px', color: 'inherit', cursor: 'pointer', padding: '2px 9px', fontSize: '11.5px' },
      input: { width: '100%', boxSizing: 'border-box', padding: '6px 9px', marginBottom: '8px', background: dim(5), border: `1px solid ${dim(16)}`, borderRadius: '8px', color: 'inherit', font: 'inherit' },
      entry: { padding: '9px 0', borderTop: `1px solid ${dim(9)}` },
      setRow: { display: 'flex', alignItems: 'baseline', gap: '10px', padding: '5px 0', borderTop: `1px solid ${dim(8)}` },
      // 专业键名的小字对照（只出现在「当前设置」卡里）：等宽 + 淡 + 一个细边药丸。
      kv: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '10.5px', color: dim(70), border: `1px solid ${dim(12)}`, borderRadius: '999px', padding: '0 5px', whiteSpace: 'nowrap' },
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

    /**
     * 毫秒 → 人话时长：「12 秒」/「15 分钟」/「2 小时」/「3 天」；不可信就「—」。
     * 早先一律印成「900s」，非技术用户得自己心算——15 分钟就该印成 15 分钟（走查发现 11）。
     */
    const fmtSecs = (ms) => {
      const n = finiteNum(ms);
      if (n === null) return '—';
      const sec = Math.round(n / 1000);
      if (sec < 90) return `${sec} 秒`;
      const min = Math.round(sec / 60);
      if (min < 90) return `${min} 分钟`;
      const hour = n / 3600000;
      if (hour < 36) return `${Math.round(hour)} 小时`;
      return `${Math.round(hour / 24)} 天`;
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

    /**
     * 时刻。**缺失时不假装是现在**（走查发现 17）：旧记录缺 ts 时印「时间未知」——
     * 印成此刻会让人以为这件事刚刚发生。要「现在」的地方自己传 Date.now()。
     */
    const fmtTime = (ms) => {
      const at = finiteNum(ms);
      if (at === null) return '时间未知';
      const d = new Date(at);
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
      'budget-too-small': '预算太小，一条都放不下',
  suppressed: '这几条被门控拦下了（一直没被用上）',
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

    /**
     * 一轮的类型 → 人话标签。**只此一份**：日志那一行、首屏清单、导出成 markdown
     * 三处都从这里取，否则同一种轮次在三个地方会有三种叫法（改文案时必定漏一处）。
     */
    const entryLabel = (kind) => (kind === 'hit' ? '提醒'
      : kind === 'skip' ? '没提醒'
        : kind === 'deny' ? '拦下一个写入'
          : kind === 'deny-error' ? '写入保护出错'
            : kind === 'sediment' ? '问了句要不要记'
              : kind === 'archive-auto' ? '自动归档'
                // pull 档（0.21.0）：这一轮一条指针都没给，只留了一句「自己去查」的话。
                : kind === 'hint' ? '只提示了一句：让它自己去查' : '没找到线索');

    /** 轮次的语气：绿 = 好事（提醒被带进去了）……与 TONE 同一套语义。 */
    const entryTone = (kind) => (kind === 'hit' ? 'hit'
      : kind === 'skip' ? 'skip'
        : kind === 'deny' ? 'deny'
          // `hint`（0.21.0）走蓝色（= 建议）：它是「库里可能有你要的东西」的提示，
          // 既不是命中（绿的语义是「指针被带进去了」，这一档恰恰没有指针），也不是没说话。
          : (kind === 'sediment' || kind === 'archive-auto' || kind === 'hint') ? 'sediment' : 'note');

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

    /* ══ 面板 2.0：首屏三问 ════════════════════════════════════════════════
     * 首屏只回答三个问题，三块**长得不一样** —— 因为它们答的是三件不同的事：
     * 「这一轮给了什么」是一份清单，「用上了多少」是一条趋势，「有没有人被拦住」是
     * 一行状态。把三块做成三张同规格的卡，就退化回仪表盘：数字齐了，问题没答。
     * 库的现状（篇数 / 片段 / 字节 / 索引行数）降级成一行小字 —— 它是背景，不是结论。
     * ═══════════════════════════════════════════════════════════════════ */

    /**
     * 交互态只能用 CSS：悬停、焦点环、动效偏好，内联样式一个都表达不了。
     * 这里只写形状与状态，**不写配色** —— 面板嵌在宿主主题里，颜色一律走 currentColor。
     */
    const CSS = [
      '.er-tab,.er-btn,.er-input{transition:background-color 120ms ease-out,border-color 120ms ease-out}',
      '.er-tab:hover,.er-btn:hover{background:color-mix(in srgb,currentColor 8%,transparent)}',
      '.er-tab:active,.er-btn:active{background:color-mix(in srgb,currentColor 14%,transparent)}',
      '.er-tab:focus-visible,.er-btn:focus-visible,.er-input:focus-visible{outline:2px solid color-mix(in srgb,currentColor 60%,transparent);outline-offset:2px}',
      '.er-entry:hover{background:color-mix(in srgb,currentColor 4%,transparent)}',
      '.er-num{font-variant-numeric:tabular-nums}',
      '.er-trend{display:flex;align-items:flex-end;gap:3px;height:34px}',
      '.er-bar{flex:1 1 0;min-width:5px;border-radius:2px 2px 0 0}',
      '.er-median{position:relative}',
      '.er-median::after{content:"";position:absolute;left:0;right:0;top:calc(var(--med,0) * 1%);border-top:1px dashed color-mix(in srgb,currentColor 38%,transparent);pointer-events:none}',
      '.er-scroll{scrollbar-width:thin}',
      '.er-scroll::-webkit-scrollbar{width:10px;height:10px}',
      '.er-scroll::-webkit-scrollbar-thumb{background:color-mix(in srgb,currentColor 20%,transparent);border:3px solid transparent;border-radius:99px;background-clip:content-box}',
      '@media (prefers-reduced-motion:reduce){.er-tab,.er-btn,.er-input{transition:none}}',
    ].join('');

    /**
     * `<style>` 挂进面板根节点。用 dangerouslySetInnerHTML 而不是把 CSS 当子节点：
     * 渲染树里那一大坨字符串会混进「面板上写了什么字」的断言里，读起来全是噪声。
     */
    const PanelStyle = () => h('style', { dangerouslySetInnerHTML: { __html: CSS } });

    const pad2 = (n) => String(n).padStart(2, '0');

    const pad3 = (n) => String(n).padStart(3, '0');

    /** 一组数的中位（偶数个取下中位，与宿主侧 usage.js 的 q() 同口径）。 */
    const midValue = (list) => {
      const sorted = list.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
      return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
    };

    /** 状态点：这一条后来有没有被打开过。**颜色之外一定有文字** —— 只靠颜色说话等于没说。 */
    /**
     * 状态点。除颜色外还有形状差别（实心＝被打开过、空心＝没被打开过、灰点＝不知道）——
     * 色盲用户和黑白打印都读得出来；旁边的文字才是主证据，点只是让它一眼可见。
     */
    const dotStyle = (tone) => {
      const base = { width: '7px', height: '7px', borderRadius: '50%', flex: 'none', display: 'inline-block', marginTop: '5px' };
      if (tone === 'hit') return { ...base, background: toneColor('hit') };
      if (tone === 'note') return { ...base, background: 'transparent', boxShadow: `inset 0 0 0 1.5px ${toneColor('note')}` };
      return { ...base, background: dim(tone === 'unknown' ? 32 : 26) };
    };

    /** 细长余量条：索引行数这类「离上限还有多远」的量。数字照旧印在右边。 */
    function Meter({ value, max, tone, unit = '' }) {
      const v = finiteNum(value);
      const m = finiteNum(max);
      const ratio = v === null || !m ? 0 : Math.max(0, Math.min(1, v / m));
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
        h('span', {
          style: { width: '58px', height: '4px', borderRadius: '2px', background: dim(14), overflow: 'hidden' },
          'aria-hidden': 'true',
        }, h('span', {
          style: {
            display: 'block', height: '100%', width: `${Math.round(ratio * 100)}%`,
            background: tone ? toneColor(tone) : dim(45),
            transition: 'width 120ms ease-out',
          },
        })),
        h('span', { className: 'er-num' }, `${fmtNum(v, unit)}/${fmtNum(m, unit)}`));
    }

    /**
     * 趋势条：一根柱子一个「第几条提醒」，柱高就是这条被用上的比例，虚线是中位数。
     * 上限按最高那根归一（不是按 100%）—— 否则一排柱子全长一样高，读不出差别。
     */
    function TrendStrip({ bars, median, caption }) {
      const peak = Math.max(0.0001, ...bars.map((b) => b.value));
      const medPct = Math.max(0, Math.min(100, (1 - Math.min(1, median / peak)) * 100));
      return h('div', null,
        h('div', {
          className: 'er-trend er-median',
          style: { maxWidth: '420px', '--med': String(medPct) },
          role: 'img',
          'aria-label': bars.map((b) => `${b.label} ${fmtPct(b.value)}`).join('，'),
        }, bars.map((b, i) => h('span', {
          key: i,
          className: 'er-bar',
          title: `${b.label}：给过 ${b.injected} 条，被用上 ${b.opened} 条（${fmtPct(b.value)}）`,
          style: {
            height: b.value > 0 ? `${Math.max(8, Math.round((b.value / peak) * 100))}%` : '2px',
            background: b.value > 0 ? toneColor('hit') : dim(22),
          },
        }))),
        caption ? h('div', { style: { ...S.note, marginTop: '4px' } }, caption) : null);
    }

    /** 首屏的一问：标题就是问题本身，下面接它自己的形状（清单 / 趋势 / 一行状态）。 */
    function Question({ title, note, action, children }) {
      return h('section', { style: S.ask },
        h('div', { style: S.between },
          h('div', { style: { minWidth: '200px', flex: '1 1 auto' } },
            h('h2', { style: S.q }, title),
            note ? h('div', { style: S.note }, note) : null),
          action || null),
        h('div', { style: { marginTop: '8px' } }, children));
    }

    /** 空状态：一句话说清「现在是什么」+ 一句「下一步做什么」—— 空屏不等于没话说。 */
    const Empty = ({ text, next }) => h('div', { style: S.note },
      text,
      next ? h('div', { style: { marginTop: '3px' } }, next) : null);

    /**
     * 首屏第一问：最新一轮的清单 —— 每条提醒一个状态点 + 一句「后来有没有被翻开」。
     * 状态点是我们独有的信息（别家只报体积），所以它值得一眼可见；但**点旁边一定有字**：
     * 只靠颜色说话，色盲用户和黑白打印都读不出来。
     */
    function RoundPeek({ latest, lastHit, opened }) {
      if (!lastHit) {
        return h(Empty, {
          text: latest
            ? `最近一轮（${fmtTime(latest.at)}）什么都没提醒：${reasonText(latest.reason) || entryLabel(latest.kind)}`
            : '还没有提醒记录。',
          next: '绝大多数轮次本来就不该提醒 —— 问一个具体问题、和它聊上两轮，这里就会记下第一轮。',
        });
      }
      const hits = objsOnly(lastHit.hits);
      return h('div', null,
        h('div', { style: S.row },
          h('span', { style: { ...S.mono, ...S.muted, fontSize: '11px' } }, fmtTime(lastHit.at)),
          h('span', { style: S.chip('hit') }, `提醒 ${fmtNum(lastHit.injected, ' 条')}`),
          lastHit.chars ? h('span', { style: S.note }, `${fmtNum(lastHit.chars, ' 字')}`) : null,
          h('span', { style: { ...S.note, flex: '1 1 200px', minWidth: '150px' } }, `问的是：${lastHit.query || '（空）'}`)),
        h('div', { style: { marginTop: '6px' } }, hits.map((hit, i) => {
          const status = openedText(opened, hit.id);
          return h('div', { key: i, style: S.line },
            h('span', { style: dotStyle(status.tone), role: 'img', 'aria-label': status.text }),
            h('span', { style: { ...S.mono, flex: '1 1 240px', minWidth: '160px' } },
              `${hit.id}${hit.section ? ` § ${hit.section}` : ''}`),
            h('span', { className: 'er-num', style: S.note }, `相关度 ${fmtNum(hit.score)}`),
            h('span', {
              style: { ...S.note, color: status.tone ? toneColor(status.tone) : undefined, whiteSpace: 'nowrap' },
            }, status.text));
        })),
        latest && latest !== lastHit
          ? h('div', { style: { ...S.note, marginTop: '6px' } },
            `上一轮（${fmtTime(latest.at)}）没提醒：${reasonText(latest.reason) || entryLabel(latest.kind)}`)
          : null);
    }

    /** 笔记 id → 累计被打开次数。查不到 = 不知道（老账本 / 不在窗口里），不许当成 0。 */
    const openedIndex = (usage) => {
      const map = new Map();
      for (const note of objsOnly(usage && usage.notes)) {
        if (typeof note.id === 'string' && note.id) map.set(note.id, finiteNum(note.opened));
      }
      return map;
    };

    /**
     * 一条指针「后来怎么样了」。三态要能被一眼分清（走查发现 1）：
     * 账本里没这条 id 时是**不知道**，不是「没被用上」——旧文案「还没记到它」会被读成后者。
     */
    const openedText = (index, id) => {
      const n = index.get(id);
      if (n === undefined || n === null) return { tone: 'unknown', text: '不知道（账本里没它）' };
      return n > 0
        ? { tone: 'hit', text: `后来被打开过 ${n} 次` }
        : { tone: 'note', text: '没被打开过' };
    };

    /** 一轮 → markdown（「复制这一轮」与「导出」共用一份，免得两处格式各写各的）。 */
    const roundMarkdown = (entry, index) => {
      const at = new Date(finiteNum(entry.at) || Date.now());
      const kind = entry.kind;
      const head = kind === 'hit'
        ? `提醒 ${fmtNum(entry.injected, ' 条')}${entry.chars ? ` / ${fmtNum(entry.chars, ' 字')}` : ''}`
        : `${entryLabel(kind)}${entry.reason ? `（${reasonText(entry.reason)}）` : ''}`;
      const lines = [`- ${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())} · ${head} · 提问：${entry.query || '（空）'}`];
      for (const hit of objsOnly(entry.hits)) {
        const status = openedText(index, hit.id);
        lines.push(`  - ${hit.id}${hit.section ? ` § ${hit.section}` : ''} — 相关度 ${fmtNum(hit.score)} — ${status.text}`);
      }
      return lines.join('\n');
    };

    /** 最近 N 轮 → 一份可以贴进 issue 的 markdown。 */
    const logMarkdown = (entries, index, limit) => {
      const list = entries.slice(0, limit);
      return [
        `# 记忆召回记录（最近 ${list.length} 轮）`,
        '',
        ...list.map((entry) => roundMarkdown(entry, index)),
        '',
      ].join('\n');
    };

    /**
     * 复制到剪贴板：非安全上下文 / 老宿主里可能没有 clipboard API。失败不是错误 ——
     * 面板是只读观测窗，复制不了不该影响任何别的事（返回 false，由调用方给人话提示）。
     */
    const copyText = (text) => {
      try {
        const clip = globalThis.navigator && globalThis.navigator.clipboard;
        if (clip && typeof clip.writeText === 'function') {
          clip.writeText(text);
          return true;
        }
      } catch { /* 忽略：复制失败不影响面板 */ }
      return false;
    };

    /** 下载一段 markdown：只用 document / URL / Blob，全程在 try 里 —— 拿不到就返回 false。 */
    const saveText = (name, text) => {
      try {
        const doc = globalThis.document;
        const url = globalThis.URL;
        if (!doc || typeof doc.createElement !== 'function' || !url || typeof url.createObjectURL !== 'function') return false;
        const href = url.createObjectURL(new globalThis.Blob([text], { type: 'text/markdown;charset=utf-8' }));
        const a = doc.createElement('a');
        a.href = href;
        a.download = name;
        a.click();
        url.revokeObjectURL(href);
        return true;
      } catch { return false; }
    };

    /* ══ 组件 ══════════════════════════════════════════════════════════════ */

    /** 概览卡：大字是结论，小字回答「这个数是什么、从哪来」。 */

    /** 「说明 + 大数字」小块 —— 0.18.0 起用 S.stat 的细边框版本，读数和小字一起给。 */
    function Stat({ label, value, hint }) {
      return h('div', { style: S.stat },
        h('div', { style: S.label }, label),
        h('div', { style: { ...S.num, ...S.mono } }, value),
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

    /** 「左栏 + 说明」两列行：说明页签与设置卡共用同一种排版，免得各写一套对齐。 */
    const rowsOf = (pairs, leftStyle) => pairs.map(([left, right], i) => h('div', { key: i, style: S.setRow },
      h('span', { style: leftStyle }, left),
      h('span', { style: { flex: '1 1 auto', ...S.note } }, right)));

    function LogEntry({ entry, expanded, onToggle, opened }) {
      const kind = entry.kind;
      const tone = entryTone(kind);
      const label = kind === 'hit' ? `提醒 ${fmtNum(entry.injected, ' 条')}` : entryLabel(kind);
      // 0.13.9 起连元素一起兜：hits 不是数组、或数组里混了 null / 字符串，都当「没有明细」，
      // 不再读 hit.id 抛异常（渲染期抛异常 = 整片白屏）。
      const hits = objsOnly(entry.hits);
      const reason = reasonText(entry.reason);
      const index = opened || new Map();

      return h('div', { className: 'er-entry', style: S.entry },
        h('div', { style: S.row },
          h('span', { style: { ...S.mono, ...S.muted, fontSize: '11px', whiteSpace: 'nowrap' } }, fmtTime(entry.at)),
          h('span', { style: S.chip(tone) }, label),
          h('span', { style: { flex: '1 1 220px', minWidth: '150px' } }, entry.query || '（空）'),
          kind === 'hit' ? h('span', { style: { ...S.mono, ...S.muted, fontSize: '11px', whiteSpace: 'nowrap' } }, fmtNum(entry.chars, ' 字')) : null,
          entry.nudge ? h('span', { style: S.chip('note') }, '顺带问了一句要不要记') : null,
          // 「提醒 5 条」却只列 4 条会被当成丢数据 —— 按钮上直接写清是「前 4 条」。
          hits.length ? h('button', { className: 'er-btn', style: S.btn, onClick: onToggle }, expanded ? '收起' : (hits.length > 4 ? `展开全部 ${hits.length} 条` : '展开')) : null),
        // 每条线索前面的状态点 = 这条笔记**累计**有没有被翻开过（首屏第一问同一份口径）。
        // 「前 4 条」的截断照旧明说，不让人以为丢数据。
        hits.length ? h('div', { style: { ...S.row, gap: '4px 12px', marginTop: '4px' } },
          hits.slice(0, 4).map((hit, i) => {
            const status = openedText(index, hit.id);
            return h('span', { key: i, style: { ...S.row, gap: '5px' } },
              h('span', { style: { ...dotStyle(status.tone), marginTop: '6px' }, role: 'img', 'aria-label': status.text }),
              h('span', { style: { ...S.mono, ...S.muted, fontSize: '11.5px' } },
                `${hit.id}${hit.section ? ` § ${hit.section}` : ''} · ${fmtNum(hit.score)}`));
          })) : null,
        reason ? h('div', { style: { ...S.note, marginTop: '3px' } },
          kind === 'skip' ? `没提醒的原因：${reason}` : reason) : null,
        // 截断提示永远是这一条的最后一句：先给结论，再解释为什么只看到 4 条。
        hits.length > 4 && !expanded
          ? h('div', { style: { ...S.note, marginTop: '3px' } }, `上面是前 4 条，一共 ${hits.length} 条 —— 点「展开全部」看全。`)
          : null,
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
      // 「导出/复制完了说一句」——人话反馈。空串 = 还没动作过（不是错误）。
      const [flash, setFlash] = React.useState('');
      // 日志的第二个筛子：先按文字筛，再按轮次类型筛（两个都要，理由见 listHelp）。
      const [kindFilter, setKindFilter] = React.useState('all');

      // 页签条在首屏三问下面 —— 点「看完整账」这类按钮切页签时，顺手把它滚到视野里，
      // 否则用户点完还停在原地，以为按钮没反应。（真宿主里 scrollIntoView 一定在；测试桩里没有。）
      const tabsRef = React.useRef(null);

      const goto = (next) => {
        setTab(next);
        const el = tabsRef.current;
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      };

      // 「还没状态」也要有分寸：整库都没配上路径时，别让人等一个永远不会来的快照。
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
      const SEV_COLOR = { error: toneColor('deny'), warn: toneColor('note'), info: dim(70) };
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
        className: 'er-tab',
        style: { ...S.seg, ...(tab === id ? S.segOn : {}) },
        onClick: () => goto(id),
        'aria-current': tab === id ? 'true' : undefined,
      }, text);

      // ── 首屏三问的原料（全部取自已有账，不新造指标） ────────────────────
      // 「这一轮提醒了什么」：最近一轮；若最近一轮压根没提醒，另外记住最近**真的提醒过**
      // 的那一轮 —— 否则寒暄之后首屏会只剩「没提醒」，「它最近到底干了什么」被藏起来。
      const latest = log[0] || null;
      const lastHit = latest && latest.kind === 'hit' && objsOnly(latest.hits).length
        ? latest
        : log.find((e) => e.kind === 'hit' && objsOnly(e.hits).length) || null;
      const opened = openedIndex(usage);
      // 「用上了多少」的趋势：按**第几条**看被翻开的比例（第 1 条 / 第 2 条 …）。
      // 为什么不是「最近 20 轮的打开率曲线」：账本汇总里没有逐轮的分子（打开事件不落「算在哪一轮」），
      // 硬画一条 20 轮的曲线就是编数；名次曲线是同一份账里**真实可算**的那一维，
      // 而且它直接回答「每次最多提醒几条」该定多宽 —— 这恰好是面板最该帮人定的事。
      const positionBars = positions.map((p, i) => {
        const injected = finiteNum(p && p.injected) || 0;
        const openedN = finiteNum(p && p.opened) || 0;
        // 标签取桶自己的 position，不能用过滤后的下标：桶稀疏时（第 1 桶 injected=0）
        // 会把第 2 桶的数据挂到「第 1 条」上 —— 与下面那张表同一条老防线（0.13.9）。
        const pos = finiteNum(p && p.position);
        return {
          label: `第 ${pos === null ? i + 1 : pos} 条`, injected, opened: openedN, value: injected ? openedN / injected : 0,
        };
      }).filter((b) => b.injected > 0);
      const positionMedian = midValue(positionBars.map((b) => b.value));
      // 判据句只可能是字符串：脏值（{}、[{}]）会印成「[object Object]」（fuzz 抓到的）。
      const openVerdict = usage && usage.verdicts && typeof usage.verdicts.open === 'string'
        ? usage.verdicts.open : '';
      const indexLines = finiteNum(index.lines);
      // 上限读配置（config.indexMaxLines，宿主一直在发），不再写死 200 ——
      // 早先写死会让「配成 300 + 索引 210 行」误报「快满了」（走查发现 9）。
      const indexMax = (config && finiteNum(config.indexMaxLines)) || 200;
      const indexNearlyFull = indexLines !== null && indexMax > 0 && indexLines >= indexMax * 0.9;
      const indexComfy = indexLines !== null && indexMax > 0 && indexLines < indexMax * 0.6;
      const errFindings = Number(sevCounts.error) || 0;
      const warnFindings = Number(sevCounts.warn) || 0;
      // 读侧上限的账（2026-10-17 补）：召回一次只读前 maxNotes 篇 / maxBytes 字节，
      // 超出的笔记**不进检索** —— 这件事以前完全不可见，现象只是「召回变差」。
      // 数据来自 /state 的 storeStats（readDocsReport 的账）；老宿主没这个字段就整块不渲染。
      const storeStats = state.storeStats && typeof state.storeStats === 'object' ? state.storeStats : null;
      const droppedTotal = storeStats
        ? (Number(storeStats.droppedByCount) || 0) + (Number(storeStats.droppedByBytes) || 0) + (Number(storeStats.droppedBySize) || 0)
        : 0;
      const capNote = storeStats && Number(storeStats.maxNotes) > 0
        ? `一次召回最多读 ${storeStats.maxNotes} 篇 / ${Math.round((Number(storeStats.maxBytes) || 0) / 1024)} KB`
        : '';
      const infoFindings = Number(sevCounts.info) || 0;

      // 日志的两个筛子：文字（提问 / 笔记名 / 原因）与轮次类型。两个都要 ——
      // 「这条笔记都在哪几轮出现过」和「没提醒的都是为什么」是两种真实的问法。
      const kindBucket = (kind) => (kind === 'hit' ? 'hit'
        : (kind === 'deny' || kind === 'deny-error') ? 'deny'
          : kind === 'sediment' ? 'sediment' : 'skip');
      const needle = filter.trim().toLowerCase();
      const filteredLog = log.filter((entry) => {
        if (kindFilter !== 'all' && kindBucket(entry.kind) !== kindFilter) return false;
        if (!needle) return true;
        const hay = [entry.query, reasonText(entry.reason), ...objsOnly(entry.hits).map((hit) => hit.id)]
          .filter((part) => typeof part === 'string').join(' ').toLowerCase();
        return hay.includes(needle);
      });

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

      // 复制 / 导出：都把结果说成人话。**静默失败**是面板最气人的地方 ——
      // 点了没反应，用户只会以为面板坏了，而不是「这个环境不许读剪贴板」。
      const doCopy = () => {
        const ok = copyText(logMarkdown(log, opened, 1));
        setFlash(ok
          ? '最近这一轮已经复制到剪贴板，可以直接贴进 issue 或笔记里。'
          : '这个环境不让读剪贴板 —— 换成「导出最近 20 轮」，或去记忆库拿账本原件。');
      };
      const doExport = (limit) => {
        const count = Math.min(limit, log.length);
        const ok = saveText(`engramory-recall-${count}rounds.md`, logMarkdown(log, opened, limit));
        setFlash(ok
          ? `已导出最近 ${count} 轮到浏览器的下载目录（markdown，可以直接贴）。`
          : '这个环境不支持直接下载 —— 账本原件在记忆库目录的 .engramory-recall.jsonl。');
      };

      return h('div', { style: S.root },
        h(PanelStyle),
        // ── 页头：这是什么 + 库在哪 + 什么时候读的 ──────────────────────────
        h('div', { style: S.between },
          h('div', { style: { flex: '1 1 auto', minWidth: '220px' } },
            h('div', { style: S.h1 }, '记忆库'),
            h('div', { style: S.lead }, '这一页只回答一件事：它到底帮没帮上忙。'),
            h('div', { style: { ...S.note, ...S.mono, marginTop: '2px' } },
              // 路径只可能是字符串：脏值（对象 / 数字 / 空串）一律当「没配置」——
              // 不把 [object Object] / Infinity 印在标题底下。
              typeof state.store === 'string' && state.store.trim() ? state.store : '未配置记忆库路径')),
          h('div', { style: { ...S.row, justifyContent: 'flex-end' } },
            h('span', { style: { ...S.note, whiteSpace: 'nowrap' } }, at ? `更新于 ${fmtTime(at)}` : '正在读取…'),
            h('button', {
              className: 'er-btn', style: S.btn, onClick: reload, title: '立刻重新读一次记忆库',
            }, '刷新'))),
        error ? h('div', { style: { color: toneColor('note'), marginTop: '4px', fontSize: '11.5px' } }, `状态过期：${error}`) : null,

        // 分隔点跟随本行颜色：这一行整体已是 dim(70)，再叠一层 dim 会掉到 2.9:1。
        // ── 库的现状：一行小字。它是背景，不是结论 —— 首屏留给三问 ──────────
        h('div', { style: { ...S.row, ...S.note, marginTop: '10px', gap: '4px 10px' } },
          h('span', null, `${numIn(state.totals, totals.notes)} 篇笔记`),
          h('span', { 'aria-hidden': 'true' }, '·'),
          h('span', null, `${numIn(state.totals, totals.docs)} 个可检索片段`),
          h('span', { 'aria-hidden': 'true' }, '·'),
          h('span', null, state.totals && (totals.bytes === undefined || totals.bytes === null) ? '—' : fmtBytes(totals.bytes)),
          h('span', { 'aria-hidden': 'true' }, '·'),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
            // 「已用 / 上限」而不是「余量」：80/200 到底是用了 80 还是剩 80，早先那句话说不清（走查发现 9）。
            h('span', null, '索引已用'),
            h(Meter, { value: indexLines, max: indexMax, tone: indexNearlyFull ? 'note' : 'hit' })),
          // 被上限挡住的笔记：这是「库里有多少」与「召回看得到多少」的差额，必须可见。
          droppedTotal > 0
            ? h('span', {
              style: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
              title: `${capNote}。超出的笔记不会被检索到 —— 调大 maxNotes / maxBytes，或归档掉不再用的笔记。`
                + `（按条数丢 ${Number(storeStats.droppedByCount) || 0} · 按字节丢 ${Number(storeStats.droppedByBytes) || 0} · 单篇过大丢 ${Number(storeStats.droppedBySize) || 0}）`,
            },
              h('span', dotStyle('note')),
              h('span', { style: { color: toneColor('note') } }, `有 ${droppedTotal} 篇没进检索`))
            : null),

        // ── 第一问：这一轮提醒了什么 ────────────────────────────────────────
        h(Question, {
          title: '这一轮提醒了什么？',
          note: '最近一轮带进上下文的东西，以及它们后来有没有被翻开。',
          action: log.length
            ? h('button', { className: 'er-btn', style: S.btn, onClick: () => goto('log') }, `看全部 ${log.length} 轮`)
            : null,
        }, h(RoundPeek, { latest, lastHit, opened })),

        // ── 第二问：用上了多少 ─────────────────────────────────────────────
        h(Question, {
          title: '用上了多少？',
          note: '提醒不是给得越多越好 —— 这里算的是「给出去的，后来有多少真的被翻开」。',
          action: usage && usage.pointers
            ? h('button', { className: 'er-btn', style: S.btn, onClick: () => goto('usage') }, '看完整账')
            : null,
        }, !usage
          ? h(Empty, {
            text: '宿主这一侧还没提供使用账 —— 重启一次 App（宿主代码不走热重载）后就有了。',
            next: '账本本身在记忆库目录的 .engramory-recall.jsonl，重启不会动它。',
          })
          : !usage.pointers
            ? h(Empty, {
              text: '还没有提醒记录，所以还谈不上「用上了多少」。',
              next: '攒够 20 条左右再看这些比例更靠谱 —— 前几条的百分比会剧烈跳动。',
            })
            : h('div', null,
              h('div', null,
                h('span', { className: 'er-num', style: { fontSize: '15px', fontWeight: 600 } }, fmtPct(usage.openRate ?? 0, 1)),
                h('span', null, ` —— 给出去的 ${fmtCount(usage.pointers, ' 条')}提醒里，有 ${fmtCount(usage.usedCounted, ' 条')}后来被翻开过`)),
              positionBars.length
                ? h('div', { style: { marginTop: '10px' } }, h(TrendStrip, {
                  bars: positionBars,
                  median: positionMedian,
                  // 结论句由数据决定，不写死「越往后越低」（走查发现 4：实际数据里尾巴反而是最高的，
                  // 一句硬编码的读图说明会直接把人带去相反的结论）。
                  caption: (() => {
                    const first = positionBars[0].value;
                    const last = positionBars[positionBars.length - 1].value;
                    const peak = Math.max(...positionBars.map((b) => b.value));
                    const how = last === 0
                      ? '最后几条是 0 —— 尾巴长期这样，才说明每次给得比需要的多，可以收窄。'
                      : last < peak
                        ? '尾巴比最高那档低、但没归零 —— 收不收窄，看你能接受丢掉多少。'
                        : '这组数里尾巴并不更低，反而最高 —— 窗口不必收窄，倒是可以想想多给一条。';
                    return `按「给出去的第几条」看被翻开的比例：第 1 条 ${fmtPct(first)}，`
                      + `到第 ${positionBars.length} 条 ${fmtPct(last)}；虚线是中位（${fmtPct(positionMedian)}）。${how}`;
                  })(),
                }))
                : null,
              h('div', { style: { ...S.note, marginTop: '8px' } },
                '这是代理指标：它证明笔记后来被翻开了，证明不了被写进回答里。'),
              openVerdict ? h('div', { style: { ...S.note, marginTop: '3px' } }, plainTerms(openVerdict)) : null)),

        // ── 第三问：有没有人被拦住 ──────────────────────────────────────────
        h(Question, {
          title: '有没有人被拦住？',
          note: '写入保护拦了什么、库里有没有该留意的东西 —— 这三处出问题，别的地方再好看也没用。',
        }, h('div', null,
          h('div', { style: S.row },
            h('span', { style: dotStyle(denied ? 'deny' : 'hit'), role: 'img', 'aria-label': denied ? '拦下过写入' : '没有拦过写入' }),
            h('span', null, denied
              ? `写入保护拦下过 ${denied} 次会写坏库的改动`
              : '写入保护还没拦过任何写入'),
            h('span', { style: S.muted, 'aria-hidden': 'true' }, '·'),
            // 口径只说「要处理 + 留意」：findings 总数里混着 info，把总数端出来会出现
            // 「2 项（要处理 0、留意 1）」这种加不起来的句子 —— 用户会先怀疑数字，再怀疑面板。
            h('span', null, !audit
              ? '还没拿到体检结果'
              : (errFindings + warnFindings)
                ? `体检有 ${errFindings + warnFindings} 项要处理或留意（要处理 ${errFindings}、留意 ${warnFindings}）`
                  + (infoFindings ? `，另有 ${infoFindings} 条提示` : '')
                : (infoFindings ? `体检没有要处理的问题（另有 ${infoFindings} 条提示）` : '体检没发现要处理的问题')),
            h('span', { style: S.muted, 'aria-hidden': 'true' }, '·'),
            // 「已用 / 上限」+ 一句「要不要动手」：光给数字，读者还是会问 80 算多算少（走查发现 9）。
            h('span', null, `索引 ${numIn(state.index, index.lines, ' 行')}／上限 ${fmtNum(indexMax)} 行`
              + (indexNearlyFull ? '（快满了，该压缩了）' : (indexComfy ? '（还早，不用动）' : '')))),
          h('div', { style: { ...S.row, marginTop: '8px' } },
            h('button', { className: 'er-btn', style: S.btn, onClick: () => goto('writes') }, `看写入记录（${auditEntries.length}）`),
            h('button', { className: 'er-btn', style: S.btn, onClick: () => goto('audit') }, '看体检'),
            h('button', { className: 'er-btn', style: S.btn, onClick: () => goto('archive') }, plans.length ? `看归档计划（${plans.length} 篇）` : '看归档'),
            h('button', { className: 'er-btn', style: S.btn, onClick: () => goto('help') }, '怎么关掉它'),
            h('button', { className: 'er-btn', style: S.btn, onClick: () => goto('help') }, '这些词是什么意思')))),

        // ── 页签：分段控件，选中的那个有底 ───────────────────────────────
        h('div', { style: S.segbar, role: 'tablist' },
          tabBtn('log', `提醒记录（${log.length}）`),
          // 「用上 4%」比裸的 4% 好懂：这是「提醒被用上的比例」。
          tabBtn('usage', usage && usage.pointers
            ? `用上了多少（${fmtPct(usage.openRate ?? 0)}）`
            : '用上了多少'),
          tabBtn('notes', `笔记（${notes.length}）`),
          tabBtn('audit', (() => {
            const b = audit && audit.summary && audit.summary.bySeverity;
            const n = b ? (b.error || 0) + (b.warn || 0) : 0;
            return n > 0 ? `体检（${n}）` : '体检';
          })()),
          tabBtn('index', '索引全文'),
          tabBtn('archive', plans.length ? `归档（${plans.length}）` : '归档'),
          tabBtn('writes', `写入记录（${auditEntries.length}）`),
          tabBtn('help', '说明')),

        // ── 提醒记录：每一轮给过什么、为什么没给 ─────────────────────────
        tab === 'log' ? h(Card, {
          title: '提醒记录',
          note: '最近 80 轮：没提醒的轮次也记 —— 大多数轮次本来就该什么都不带，「这轮没给」同样是结论。'
            + '没提醒可能是：闲话 / 寒暄、消息太短、一条都不匹配、被相关度门槛拦住、预算装不下 —— '
            + '每条记录下面写着是哪一种（没写原因的，是这版宿主还没上报）。',
        },
          h('div', { ref: tabsRef, style: { ...S.row, gap: '6px', marginBottom: '6px' } },
            h('input', {
              className: 'er-input',
              style: { ...S.input, width: 'auto', flex: '1 1 200px', marginBottom: 0 },
              placeholder: '按提问或笔记名筛…',
              value: filter,
              'aria-label': '按提问或笔记名筛选',
              onChange: (e) => setFilter(e.target.value),
            }),
            h('select', {
              className: 'er-input',
              style: { ...S.input, width: 'auto', marginBottom: 0 },
              value: kindFilter,
              'aria-label': '按轮次类型筛选',
              onChange: (e) => setKindFilter(e.target.value),
            }, [
              ['all', '全部轮次'], ['hit', '提醒过的'], ['skip', '没提醒的'],
              ['deny', '拦下写入的'], ['sediment', '问过要不要记的'],
            ].map(([value, text]) => h('option', { key: value, value }, text))),
            h('button', { className: 'er-btn', style: S.btn, onClick: doCopy }, '复制这一轮'),
            h('button', { className: 'er-btn', style: S.btn, onClick: () => doExport(20) }, '导出最近 20 轮')),
          flash ? h('div', { style: { ...S.note, marginBottom: '6px' } }, flash) : null,
          log.length && (needle || kindFilter !== 'all')
            ? h('div', { style: { ...S.note, marginBottom: '4px' } },
              `筛出 ${filteredLog.length}／${log.length} 轮`,
              filteredLog.length ? '' : ' —— 换个词，或把类型调回「全部轮次」。')
            : null,
          log.length
            ? (filteredLog.length
              ? filteredLog.map((entry) => h(LogEntry, {
                key: `${entry.at}-${log.indexOf(entry)}`,
                entry,
                opened,
                expanded: expanded === log.indexOf(entry),
                onToggle: () => setExpanded(expanded === log.indexOf(entry) ? -1 : log.indexOf(entry)),
              }))
              : null)
            : h(Empty, {
              text: '还没有记录：问答满一轮之后，这里就会多出一行。',
              next: '先在对话框里问一个具体问题 —— 寒暄和答话按设计不会带记忆进来。',
            }))
          : null,

        // ── 使用情况：提醒有没有被用上 ───────────────────────────────────
        // 账本在库目录的 .engramory-recall.jsonl，算法与 `npm run recall:stats` 共用
        // （宿主侧 usage.js）；标签映射也照抄那一份。
        tab === 'usage' ? h(Card, {
          // 页内标题与页签名一致（走查发现 12 的同类问题：同一个地方两个叫法）。
          title: '用上了多少',
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
                  // 字段整个缺失（老账本没汇总这一项）与「真的是 0 篇」是两件事：
                  // 前者印「—」+ 出处，否则同一张卡上会同时出现「0 篇被提醒过」和「给过 340 条提醒」（走查发现 6）。
                  label: '提醒过的笔记',
                  value: usage.uniqueNotes === undefined || usage.uniqueNotes === null
                    ? '—' : fmtCount(usage.uniqueNotes, ' 篇'),
                  hint: usage.uniqueNotes === undefined || usage.uniqueNotes === null
                    ? '这份账本没汇总这个数（重启一次 App 让新宿主开始写）'
                    : neverOpened.length ? `${neverOpened.length} 篇一次都没被用上` : '每篇都至少被用上一次',
                }),
                h(Stat, {
                  label: '多久才被用上',
                  value: openLag && openLag.n ? fmtSecs(openLag.median) : '—',
                  hint: openLag && openLag.n
                    ? `p90 ${fmtSecs(openLag.p90)} · n=${fmtNum(openLag.n)}`
                    : '还没有「被翻开」的记录可算（不是「没用上」——这个数要从打开记录里算）',
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
                  '谁在问（按提问的人拆开，与上面的总数同源）：',
                  rows.map(([name, v], i) => h('span', { key: name },
                    i ? ' · ' : '',
                    // 半个桶（有 pointers 却没有轮数/用上数）用 fmtNum 印「—」：这里出现 0
                    // 会让人以为「真的没用上过」，而事实是宿主没给这个数（0.13.9 的纪律）。
                    `${name} ${fmtNum(v.injectRounds !== undefined ? v.injectRounds : v.rounds, ' 轮')} / ${fmtNum(v.pointers, ' 条')} / 用上 ${fmtNum(v.usedCounted !== undefined ? v.usedCounted : v.used)}（${fmtPct(v.openRate ?? 0, 1)}）`)));
              })(),

              h('div', { style: { fontSize: '11.5px', marginTop: '10px' } },
                [usage.verdicts && usage.verdicts.open, usage.verdicts && usage.verdicts.budget, usage.verdicts && usage.verdicts.truncation, usage.verdicts && usage.verdicts.reason, usage.verdicts && usage.verdicts.curve]
                  // 同上：只印真字符串，脏值跳过（不印 [object Object]）。
                  .filter((v) => typeof v === 'string' && v.trim())
                  .map((v, i) => h('div', { key: i, style: S.muted }, `· ${plainTerms(v)}`))),

              // 消费侧门控的账（0.16.0 起落盘）：档位分布 + 降权/抑制的条数。
              // 老账本没有 `gate` 字段 → rounds 为 0，这一节整块不印（「没数据」不是「0 次」）。
              (() => {
                const g = usage.gate || {};
                const rounds = finiteNum(g.rounds);
                if (rounds === null || rounds === 0) return null;
                const modes = g.modes && typeof g.modes === 'object' && !Array.isArray(g.modes)
                  ? Object.entries(g.modes).filter(([, v]) => finiteNum(v) !== null)
                  : [];
                return h('div', null,
                  h('div', { style: S.sub }, '降权（门控）'),
                  h('div', { style: S.note },
                    `这一窗口有 ${fmtNum(rounds)} 轮记了档位`,
                    modes.length ? `（${modes.map(([k, v]) => `${k} ${fmtNum(v)} 轮`).join(' · ')}）` : '',
                    `：降权了 ${fmtNum(g.demotedRounds)} 轮 / ${fmtNum(g.demotedPointers)} 条，`
                    + `够到抑制线 ${fmtNum(g.readyPointers)} 条，真被移出注入 ${fmtNum(g.suppressedPointers)} 条。`),
                  h('div', { style: S.note },
                    '降权不是拉黑：只是把位置让给更可能被用上的笔记。off 不干预 / shadow 只记账 / '
                    + 'assist 降权 / enforce 移出注入 —— 改配置里的 gate 与 gateStaleDays。'));
              })(),

              usage.scoreCurve && usage.scoreCurve.n
                ? h('div', null,
                    h('div', { style: S.sub }, '抬高相关度门槛会付出什么'),
                    h('div', { style: S.note },
                      // 半截 scoreCurve（有 n 没 rounds）以前会把 undefined 写进句子 —— 全部过格式化（0.13.9）。
                      `配对 ${fmtNum(usage.scoreCurve.n)} 条提醒 / ${fmtNum(usage.scoreCurve.rounds)} 轮 —— 「配对」＝能同时算出「相关度分」和「后来有没有被翻开」的那部分`
                        + `（所以它比上面的提醒总数少）；门槛一抬，先被砍掉的就是这几条。`),
                    h('table', { style: { ...S.table, marginTop: '4px' } },
                      h('thead', null, h('tr', null,
                        h('th', { style: S.th }, '相关度门槛'),
                        h('th', { style: S.th }, '还能留几条'),
                        h('th', { style: S.th }, '比现在少'),
                        h('th', { style: S.th }, '被砍掉且曾被用上过的条数'))),
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
                  ? '逐轮明细还没有（这一节要重启一次 App 让新宿主开始写）—— 上面的条数是从旧格式汇总来的，明细要等新宿主落盘。'
                  // 半截 perRound（有 median、缺 min/p90/max）以前会漏出 undefined —— 缺的印「—」（0.13.9）。
                  : `每轮提醒 ${fmtNum(rounds.median)} 条（最少 ${fmtNum(rounds.min)} / p90 ${fmtNum(rounds.p90)} / 最多 ${fmtNum(rounds.max)}）`,
                rounds.windowLimit ? ` · 顶满窗口 ${fmtCount(rounds.fullRounds)}/${fmtCount(usage.injectRounds)} 轮` : '',
                rounds.median === undefined ? '' : ` · 有内容被截断 ${fmtCount(usage.truncatedRounds)} 轮（缩成只剩文件名 ${fmtCount(usage.collapsed)} 条、整条没列出 ${fmtCount(usage.dropped)} 条，涉及 ${fmtCount(usage.droppedRounds)} 轮）`),
              h('div', { style: S.note },
                usage.scoreStats && usage.scoreStats.n
                  ? `相关度分：中位 ${fmtNum(usage.scoreStats.median)} · p10 ${fmtNum(usage.scoreStats.p10)} · p90 ${fmtNum(usage.scoreStats.p90)} · 首尾落差中位 ${fmtNum(usage.scoreStats.spreadMedian)}（共 ${fmtCount(usage.scoreStats.n)} 轮 —— 有分数可算的那几轮）`
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
          note: `记忆库里的每一篇（共 ${fmtNum(notes.length)} 篇）；文件名、标题、描述都能搜。`
            + (filter ? ` 现在筛出 ${fmtNum(shown.length)} 篇。` : ''),
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
          title: '体检',
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
                    // 为什么挑中这一篇：被跳过的那篇写了理由，计划里的反而没写，读起来像随机（走查发现 15）。
                    plan.reason ? `${plan.reason} —— ` : '',
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

        // ── 说明：术语表 + 「我要的功能在哪个开关上」+ 数字从哪来 ─────────
        // 非技术用户的第一屏困惑通常是「这些词什么意思」「我想关掉它该点哪儿」，
        // 所以这两张清单不是附录，而是面板的一部分：**看不懂的仪表盘等于没有面板**。
        tab === 'help' ? h('div', null,
          h(Card, { title: '面板上这些词，在说什么', note: '左边是人话，右边是它在这套系统里到底指什么。' },
            rowsOf([
              ['提醒（也叫指针）', '命中的笔记里、真的被带进上下文的那几条线索；配置和账本里叫「注入 / pointer」'],
              ['可检索片段', '一篇笔记按章节切成的段 —— 搜索在这些段里找，不是在整篇里找'],
              ['被用上', '模型随后真的翻开了那篇笔记 —— 记的是「翻开」这个动作，不是引用'],
              ['打开率 / 被用上的比例', '被用上的条数 ÷ 给出去的条数；同一轮里读几遍只算一次'],
              ['代理指标', '只能间接证明的事：它证明笔记后来被翻开了，证明不了被写进回答里'],
              ['相关度', '这条笔记和这一轮提问有多贴题，是个分数（越高越贴）'],
              ['相关度门槛', '分数低于它就干脆不提醒（配置里叫 minScore）'],
              ['每次最多提醒几条', '一轮最多给几条（maxPointers）—— 给多了会把对话淹掉'],
              ['字数上限', '一轮提醒总共能占多少字（maxChars），装不下就只留文件名'],
              ['索引', 'MEMORY.md：每次提问前先读的「一行一条」小抄，上限默认 200 行（可配）'],
              ['写入保护', '模型想改记忆库时先过守卫：超上限、越界、破坏性改动会被拒'],
              ['规则版本', '写入守卫的规则代号（如 guard-v1）—— 规则一换代号就跟着变'],
              ['降权（门控）', '某条笔记给了很多次都没被翻开 → 往后少给它位置（配置里叫 gate，可关）'],
              ['抑制线', '降权降到这条线以下就不再注入它；够到线的有多少，在「用上了多少」页签'],
              ['中位 / p10 / p90', '把一串数从小到大排队：中位是正中间那个，p10 / p90 是排在 10% / 90% 位置的那个'],
              ['配对', '能同时算出「相关度分」和「后来有没有被翻开」的那部分提醒 —— 比提醒总数少'],
              ['子代理', '宿主里替你干活的下级代理；它们发起的提问也走同一套记忆，所以单独统计'],
              ['失联路径', '索引或笔记正文里指向的、文件却已经不存在的链接'],
              ['批次章节', '笔记里按批次写的章节（归档时按批搬走）'],
              ['宿主', '跑这套记忆的程序本体（DSH App / CLI / 别的客户端）'],
            ], { flex: '0 0 116px', fontWeight: 600 })),

          h(Card, {
            title: '我要的功能，在哪个开关上',
            note: '面板是只读的观测窗，不写配置。改的是 profile 的 cordis.patch.yml —— '
              + '桌面版在 ~/.dsh/profiles/<profile>/cordis.patch.yml（通常是 desktop），找到 id: engramory-recall '
              + '那段 config，改完重启一次 App 最稳。',
          },
            rowsOf([
              ['不想让它提醒', 'enabled: false（彻底关掉），或 maxPointers: 0'],
              ['嫌提醒太多 / 太少', 'maxPointers（每次几条）、maxChars（总共多少字）'],
              ['嫌每轮塞进来的线索太多', 'recallMode：push（默认，照旧推最多 maxPointers 条）· hybrid（只推最靠前的 1 条）· pull（一条指针都不推，只留一句「库里有 N 条线索」，要细节时模型自己调 engramory_search 去查）—— 默认档等对照数据出来再定，现在还没换'],
              ['总混进不相关的东西', 'minScore 抬一档 —— 抬到哪一档、抬了会丢掉几条「曾被用上过」，在「用上了多少」页签的代价曲线里逐档列着'],
              ['不要每轮都问「要不要记一笔」', 'nudge: false'],
              ['不许它自己改记忆库', 'guardWrites 保持 true（关掉它是把保护拆了，不是配置项）'],
              ['索引快满了 / 笔记太长', '「归档」页签执行归档，或手动压缩 MEMORY.md'],
              ['觉得它降权降得不对', 'gate: off（关掉自动降权）—— 降了多少、够到抑制线的有多少，在「用上了多少」页签'],
              ['想看它到底有没有用', '回到首屏三问，或「用上了多少」看完整账'],
              ['想在别的宿主里用', 'MCP：engramory-recall-mcp（只读，做法见 README）'],
            ], { flex: '0 0 172px' })),

          h(Card, { title: '这些数字从哪来', note: '全是本地文件，没有一处是估的 —— 可以自己打开对。' },
            rowsOf([
              ['提醒记录', '插件内存里最近 80 轮（重启 App 会清空）'],
              ['被用上的比例', '记忆库目录的 .engramory-recall.jsonl（跨会话累积，只追加）'],
              ['写入记录 / 拦下的改动', '同目录的 .engramory-audit.jsonl'],
              ['召回读多少', `${capNote || '一次召回只读库里靠前的若干篇'}：超出的笔记不会进检索。库超过这条线时，首屏会多一个点写「有 N 篇没进检索」—— 那时调大 maxNotes / maxBytes，或把不再用的笔记归档掉。`],
              ['体检', '索引与每篇笔记的现状：行数、字节、行宽、类型'],
              ['命令行里的同一份数据', 'npm run recall:stats  ·  npm run recall:report'],
            ], { flex: '0 0 172px' })))
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
