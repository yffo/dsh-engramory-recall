/**
 * 索引闸门等价性测试的**输入矩阵**（只有输入，没有期望值）。
 *
 * 期望值单独放在 `index-guard-equivalence.json`：那份快照取自移植版实现
 * （`index-guard.js` 的 HEAD 版本，commit 821872ac），用来证明重写是行为等价的。
 * 把「输入」与「期望」分开存，是为了让快照是可读的、可逐条核对的。
 *
 * 每个用例的字段：
 *  - `id`：快照里的键，改 ID 就等于换用例，别随手动。
 *  - `note`：这条在防什么回归（快照文件里也带着，读快照的人不用回来翻代码）。
 *  - `file`：`'index'` = `<store>/MEMORY.md`；`'index-lower'` = `<store>/memory.md`；
 *            其他字符串 = 相对 `ROOT` 的路径；以 `/` 开头 = 绝对路径（原样透传）。
 *  - `store`：`'store'`（默认）/ `'store-space'`（库路径末尾多一个空格，验证 trim）/
 *            `''`（没配库）/ 其他字符串 = 相对 `ROOT` 的路径。
 *  - `limit`：`{ maxLines, maxBytes }`，缺省即用模块默认上限。
 *  - 正文用 `content`（字符串）或 `fileB64`（base64，用来精确造坏字节 / BOM / CRLF）给。
 */

/** 第 0 行的前缀：它的字节数决定了后面垫多少个 `x`。 */
const PREFIX_BYTES = Buffer.byteLength('- note-0.md — ', 'utf8');

/**
 * 造一行**正好 `totalBytes` 字节**的正文（utf8 口径）。
 * 用「按字节算前缀长度」而不是 `str.length`：前缀里那个破折号是 3 字节，
 * 按字符数垫出来的行会短 14 字节，字节边界用例就全废了。
 */
export function corpus(totalBytes) {
  return `- note-0.md — ${'x'.repeat(totalBytes - PREFIX_BYTES)}`;
}

/**
 * 第 0 行垫到 `padBytes` 字节、总共 `count` 行的正文；`padBytes <= 0` 表示不垫
 * （每行都用普通短行）。所有边界用例都从这里派生，省得手写几百行。
 */
export function packed(padBytes, count) {
  return Array.from({ length: count }, (_, i) => {
    if (i === 0 && padBytes > 0) return corpus(padBytes);
    return `- note-${i}.md — 第 ${i} 行`;
  }).join('\n');
}

export const SMALL = '- note-a.md — 一条短钩子';

/** 库里已经严重超限的索引（400 行），用来测「只拦增长」。 */
const HUGE400 = packed(25600, 400);

export const CASES = [
  // ── 行数边界：200 放行 / 201 拒绝 ──────────────────────────────────────────
  {
    id: 'lines-200-exactly',
    note: '刚好 200 行放行（上限是「超过」才拒，等于不算超）',
    file: 'index',
    fileB64: '',
    tool: 'write',
    content: packed(0, 200),
  },
  {
    id: 'lines-201-reject',
    note: '201 行被拒 —— 行数这一维的越界点',
    file: 'index',
    fileB64: '',
    tool: 'write',
    content: packed(0, 201),
  },

  // ── 字节边界：25600 放行 / 25601 拒绝（十进制 25KB 口径）───────────────────
  {
    id: 'bytes-25600-exactly',
    note: '单行正好 25600 字节放行（字节上限是「>」，等于放行）',
    file: 'index',
    fileB64: '',
    tool: 'write',
    content: corpus(25600),
  },
  {
    id: 'bytes-25601-reject',
    note: '单行 25601 字节被拒 —— 字节这一维的越界点',
    file: 'index',
    fileB64: '',
    tool: 'write',
    content: corpus(25601),
  },
  {
    id: 'lines-245-bytes-under',
    note: '行数超（245 行）但字节没超：只报行数那一维',
    file: 'index',
    fileB64: '',
    tool: 'write',
    content: packed(10000, 245),
  },
  {
    id: 'bytes-25800-lines-200',
    note: '正好 200 行但 25800 字节：只报字节那一维',
    file: 'index',
    fileB64: '',
    tool: 'write',
    content: packed(25600, 200),
  },

  // ── 只拒绝增长：缩小重写永远放行 ──────────────────────────────────────────
  {
    id: 'shrink-205-to-203-over-limit',
    note: '当前 205 行已超限，重写成 203 行（仍然超限）必须放行 —— 否则索引锁死',
    file: 'index',
    fileB64: Buffer.from(packed(0, 205), 'utf8').toString('base64'),
    tool: 'write',
    content: packed(0, 203),
  },
  {
    id: 'grow-205-to-202-from-205',
    note: '当前 205 行，写 202 行：虽然仍超限但确实变小 → 放行；对照上一条的方向性',
    file: 'index',
    fileB64: Buffer.from(packed(0, 205), 'utf8').toString('base64'),
    tool: 'write',
    content: packed(0, 202),
  },
  {
    id: 'same-size-205-from-205',
    note: '与当前一模一样（205 行）：不算增长，放行',
    file: 'index',
    fileB64: Buffer.from(packed(0, 205), 'utf8').toString('base64'),
    tool: 'write',
    content: packed(0, 205),
  },
  {
    id: 'grow-205-to-206',
    note: '越限文件继续长大（205 → 206 行）必须被拒',
    file: 'index',
    fileB64: Buffer.from(packed(0, 205), 'utf8').toString('base64'),
    tool: 'write',
    content: packed(0, 206),
  },
  {
    id: 'byte-shrink-25800-to-25600',
    note: '行数不变（200）、字节从 25800 缩到 25600：字节那一维只拦增长，放行',
    file: 'index',
    fileB64: Buffer.from(packed(25600, 200), 'utf8').toString('base64'),
    tool: 'write',
    content: packed(25600, 200),
  },
  {
    id: 'byte-shrink-25800-to-25700-still-over',
    note: '行数不变（200）、字节 25800 → 25700（即超限），仍然放行',
    file: 'index',
    fileB64: Buffer.from(packed(25600, 200), 'utf8').toString('base64'),
    tool: 'write',
    content: packed(25700, 200),
  },
  {
    id: 'byte-grow-25800-to-25900',
    note: '越限文件继续长胖（+100 字节）：被拒',
    file: 'index',
    fileB64: Buffer.from(packed(25600, 200), 'utf8').toString('base64'),
    tool: 'write',
    content: packed(25900, 200),
  },
  {
    id: 'file-absent-oversized',
    note: '库里还没有索引时写一份超限的：直接拒（没有「变小」可言）',
    file: 'index',
    tool: 'write',
    content: packed(0, 999),
  },
  {
    id: 'file-absent-small',
    note: '库里还没有索引时写一份正常的：放行',
    file: 'index',
    tool: 'write',
    content: SMALL,
  },

  // ── 超长单行 / 多字节 ────────────────────────────────────────────────────
  {
    id: 'single-huge-line',
    note: '一行 10 万字符：行数没超但字节爆表 → 拒（且行数那一维不出现）',
    file: 'index',
    fileB64: '',
    tool: 'write',
    content: 'x'.repeat(100000),
  },
  {
    id: 'utf8-multibyte-under-cap',
    note: '多字节正文：字节按 utf8 算（一个中文字 3 字节），100 行中文仍在上限内 → 放行',
    file: 'index',
    fileB64: '',
    tool: 'write',
    content: Array.from({ length: 100 }, () => '- 中文钩子：这是一条记忆的指针').join('\n'),
  },
  {
    id: 'utf8-multibyte-over-cap',
    note: '800 行中文（约 40KB）：行数与字节两维都超 → 理由里两维都出现',
    file: 'index',
    fileB64: '',
    tool: 'write',
    content: Array.from({ length: 800 }, () => '- 中文钩子：这是一条记忆的指针').join('\n'),
  },

  // ── edit：把片段换成更长 / 更短 ──────────────────────────────────────────
  {
    id: 'edit-grow-over-line-cap',
    note: 'edit 把一段换成更长的：模拟出 205 行 → 拒（判的是替换后的结果）',
    file: 'index',
    fileB64: Buffer.from(packed(0, 200), 'utf8').toString('base64'),
    tool: 'edit',
    oldString: '- note-199.md — 第 199 行',
    newString: Array.from({ length: 6 }, (_, i) => `- 新增-${i}.md`).join('\n'),
  },
  {
    id: 'edit-shrink-huge',
    note: 'edit 把 400 行里的前 300 行换成一行：缩小 → 放行',
    file: 'index',
    fileB64: Buffer.from(HUGE400, 'utf8').toString('base64'),
    tool: 'edit',
    oldString: HUGE400.split('\n').slice(0, 300).join('\n'),
    newString: '- 就剩这一行了',
  },
  {
    id: 'edit-line-count-unchanged-byte-shrink',
    note: 'edit 逐行变短：行数从 400 降到 399、字节也变小 → 放行',
    file: 'index',
    fileB64: Buffer.from(HUGE400, 'utf8').toString('base64'),
    tool: 'edit',
    oldString: '- note-399.md — 第 399 行',
    newString: '- note-399',
  },
  {
    id: 'edit-append-tiny-to-huge',
    note: '给 400 行的索引追加一小段（+1 行）：即使只长一点也拒',
    file: 'index',
    fileB64: Buffer.from(HUGE400, 'utf8').toString('base64'),
    tool: 'edit',
    oldString: '- note-399.md — 第 399 行',
    newString: '- note-399.md — 第 399 行\n- 追加的一行',
  },
  {
    id: 'edit-old-string-missing',
    note: 'old_string 找不到：真实工具会报错不改文件，所以按「当前内容」判 → 已超限即拒',
    file: 'index',
    fileB64: Buffer.from(HUGE400, 'utf8').toString('base64'),
    tool: 'edit',
    oldString: '- 这段根本不存在',
    newString: '- 随便',
  },
  {
    id: 'edit-old-string-ambiguous',
    note: 'old_string 出现多次：工具同样什么都不改，按当前内容判 → 已超限即拒',
    file: 'index',
    fileB64: Buffer.from(HUGE400, 'utf8').toString('base64'),
    tool: 'edit',
    oldString: '- note-1',
    newString: '- note-1（改）',
  },
  {
    id: 'edit-new-string-missing',
    note: 'new_string 缺失按空串算（= 删除该片段）：真缩小 → 放行',
    file: 'index',
    fileB64: Buffer.from(packed(0, 200), 'utf8').toString('base64'),
    tool: 'edit',
    oldString: '\n- note-199.md — 第 199 行',
  },
  {
    id: 'edit-unmeasurable-over-limit',
    note: 'old_string 是空串（形状不认）且索引已超限 → 拒绝盲改，理由里带出口',
    file: 'index',
    fileB64: Buffer.from(HUGE400, 'utf8').toString('base64'),
    tool: 'edit',
    oldString: '',
    newString: packed(0, 401),
  },
  {
    id: 'edit-unmeasurable-not-over',
    note: 'old_string 不是字符串且索引没超限 → 放行并标 skipped: unmeasurable',
    file: 'index',
    fileB64: Buffer.from(SMALL, 'utf8').toString('base64'),
    tool: 'edit',
    oldString: undefined,
    newString: 'x',
  },
  {
    id: 'edit-current-file-absent',
    note: 'edit 但当前文件读不到 → skipped: no-current（不替工具预判）',
    file: 'index',
    tool: 'edit',
    oldString: 'a',
    newString: 'b',
  },

  // ── 换行风格 / BOM ───────────────────────────────────────────────────────
  {
    id: 'crlf-201-reject',
    note: 'CRLF 正文：行数按 \\n 数（201 行照样拒），\\r 只进字节数',
    file: 'index',
    fileB64: '',
    tool: 'write',
    content: packed(0, 201).replace(/\n/g, '\r\n'),
  },
  {
    id: 'cr-only-500-lines',
    note: '纯 CR 换行：不是 \\n，500 个「行」在行数口径里只是 1 行',
    file: 'index',
    fileB64: '',
    tool: 'write',
    content: Array.from({ length: 500 }, (_, i) => `- note-${i}.md`).join('\r'),
  },
  {
    id: 'crlf-shrink-over-limit',
    note: '当前是 LF 的 25800 字节，重写成 CRLF 但只有 300 行：字节变小 → 放行',
    file: 'index',
    fileB64: Buffer.from(packed(25600, 200), 'utf8').toString('base64'),
    tool: 'write',
    content: packed(0, 300).replace(/\n/g, '\r\n'),
  },
  {
    id: 'bom-pushes-over-bytes',
    note: 'BOM 占 3 字节，把正好 25600 字节的正文顶成 25603 → 拒（字节那一维）',
    file: 'index',
    fileB64: Buffer.from(corpus(25600), 'utf8').toString('base64'),
    tool: 'write',
    content: `\uFEFF${corpus(25600)}`,
  },
  {
    id: 'bom-removed-shrinks',
    note: '当前文件带 BOM（25603 字节），重写时去掉 BOM（25600）→ 变小，放行',
    file: 'index',
    fileB64: Buffer.from(`\uFEFF${corpus(25600)}`, 'utf8').toString('base64'),
    tool: 'write',
    content: corpus(25600),
  },

  // ── 末尾换行 ─────────────────────────────────────────────────────────────
  {
    id: 'trailing-newline-ignored',
    note: '200 行 + 末尾换行：行数仍是 200（末尾那一个换行不另算一行）',
    file: 'index',
    fileB64: '',
    tool: 'write',
    content: `${packed(0, 200)}\n`,
  },
  {
    id: 'trailing-newline-201-still-rejected',
    note: '201 行 + 末尾换行：仍然拒（末尾敏感会把它算成 202，那是另一个口径）',
    file: 'index',
    fileB64: '',
    tool: 'write',
    content: `${packed(0, 201)}\n`,
  },

  // ── 空文件 ───────────────────────────────────────────────────────────────
  {
    id: 'empty-file-empty-write',
    note: '空文件写空内容：放行（没超限）',
    file: 'index',
    fileB64: '',
    tool: 'write',
    content: '',
  },
  {
    id: 'empty-file-implicit-missing',
    note: '文件字段缺省 = 不存在：写空内容放行（第一次写入就是空索引）',
    file: 'index',
    tool: 'write',
    content: '',
  },
  {
    id: 'empty-file-huge-write',
    note: '空文件（真实存在但 0 字节）写一份超限：拒',
    file: 'index',
    fileB64: '',
    tool: 'write',
    content: packed(0, 300),
  },

  // ── 管辖范围：大小写 / 库外 / 非索引 / 没配库 ──────────────────────────────
  {
    id: 'lowercase-memory-md-oversized',
    note: '小写 memory.md 就是那份索引（macOS/Windows 上同一个文件），照样拒',
    file: 'index-lower',
    fileB64: '',
    tool: 'write',
    content: packed(0, 999),
  },
  {
    id: 'outside-store-same-name',
    note: '库外同名的 MEMORY.md 不归它管 → skipped: outside-store',
    file: 'outside/MEMORY.md',
    fileB64: '',
    tool: 'write',
    content: packed(0, 999),
  },
  {
    id: 'other-file-in-store',
    note: '库根目录下的笔记文件（与索引同目录，但不是索引）不归上限管 → skipped: not-index',
    file: 'store/project-x.md',
    fileB64: '',
    tool: 'write',
    content: packed(0, 999),
  },
  {
    id: 'nested-file-in-store',
    note: '库内子目录里的同名文件：不在库根目录上，同样不归它管 → skipped: outside-store',
    file: 'store/nested/MEMORY.md',
    fileB64: '',
    tool: 'write',
    content: packed(0, 999),
  },
  {
    id: 'no-store-configured',
    note: '没配库（storePath 空）→ skipped: not-configured',
    file: 'outside/MEMORY.md',
    store: '',
    fileB64: '',
    tool: 'write',
    content: packed(0, 999),
  },
  {
    id: 'store-path-with-trailing-space',
    note: 'storePath 末尾带空格（`store ` 解析出来是另一个目录）：trim 之后才落在真正的库根目录上 → 该拒的照样拒',
    file: 'index',
    store: 'store ',
    fileB64: '',
    tool: 'write',
    content: packed(0, 999),
  },
  {
    id: 'relative-file-path',
    note: '相对 filePath 按进程 cwd 解析（宿主传的是绝对路径，这条只钉住既有口径）',
    file: 'outside/MEMORY.md',
    fileB64: '',
    tool: 'write',
    content: packed(0, 999),
  },
  {
    id: 'unknown-tool',
    note: '既不是 write 也不是 edit 的工具调用 → skipped: not-a-write',
    file: 'index',
    fileB64: '',
    tool: 'read',
    content: packed(0, 999),
  },
  {
    id: 'write-without-content',
    note: 'write 没带 content → skipped: no-content（不猜内容）',
    file: 'index',
    fileB64: '',
    tool: 'write',
  },

  // ── 可配上限 ─────────────────────────────────────────────────────────────
  {
    id: 'custom-caps',
    note: '自定义上限（5 行 / 1024 字节）：6 行就该拒 —— 上限参数真的被用了',
    file: 'index',
    fileB64: '',
    tool: 'write',
    content: packed(0, 6),
    limit: { maxLines: 5, maxBytes: 1024 },
  },
];

/** 把矩阵里的一条还原成 `checkIndexWrite` 的参数（路径用运行时的 root 补全）。 */
export function materialize(testCase, root) {
  const storeRoot = testCase.store === undefined ? `${root}/store` : testCase.store === '' ? '' : `${root}/${testCase.store}`;

  const filePath =
    testCase.file === 'index'
      ? `${root}/store/MEMORY.md`
      : testCase.file === 'index-lower'
        ? `${root}/store/memory.md`
        : testCase.file.startsWith('/')
          ? testCase.file
          : `${root}/${testCase.file}`;

  return {
    filePath,
    storePath: storeRoot,
    tool: testCase.tool,
    content: testCase.content,
    oldString: testCase.oldString,
    newString: testCase.newString,
    ...(testCase.limit ?? {}),
  };
}

/** 矩阵里每条用例要落盘的原始字节（没有该字段 = 文件不存在）。 */
export function seedBytes(testCase) {
  if (testCase.fileB64 === undefined) return undefined;
  if (testCase.fileB64 === '') return Buffer.alloc(0);
  return Buffer.from(testCase.fileB64, 'base64');
}
