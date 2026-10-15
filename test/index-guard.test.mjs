/**
 * 索引上限闸门的测试。
 *
 * 这套用例的存在理由：`checkIndexWrite` 是**融合自 dsh-engramory** 的逻辑（见
 * `index-guard.js` 文件头）。搬过来的代码最危险的失效方式不是报错，而是**语义悄悄变了**
 * —— 尤其是「缩小的重写永远放行」那条例外，它看着像后门，实际是唯一的出路：索引一旦
 * 超限，若不做例外，任何写入都被拒，就没有任何一次写入能让它降下来，闸门会把自己锁死。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  DEFAULT_MAX_INDEX_BYTES,
  DEFAULT_MAX_INDEX_LINES,
  checkIndexWrite,
  countLines,
  measureIndex,
} from '../index-guard.js';

const roots = [];
function makeStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'eng-index-'));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** 造一个正好 n 行的索引正文。 */
const lines = (n) => Array.from({ length: n }, (_, i) => `- note-${i}.md — 第 ${i} 行`).join('\n');

const check = (input) =>
  checkIndexWrite({ storePath: '', tool: 'write', content: lines(3), ...input });

describe('索引闸门：只认自己那一份文件', () => {
  it('非索引文件一律 skipped，不介入', () => {
    const store = makeStore();
    const r = check({ storePath: store, filePath: path.join(store, 'project-x.md'), content: lines(999) });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, 'not-index');
  });

  it('没配库（storePath 为空）时 skipped', () => {
    const r = check({ storePath: '', filePath: '/anywhere/MEMORY.md' });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, 'not-configured');
  });

  it('只认 <storePath>/MEMORY.md —— 别的仓库里同名的 MEMORY.md 不归它管', () => {
    const store = makeStore();
    const r = check({ storePath: store, filePath: '/somewhere/else/MEMORY.md', content: lines(999) });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, 'outside-store');
  });

  it('顶层不存在的文件 skipped（尚未开始写）', () => {
    const store = makeStore();
    const r = check({ storePath: store, filePath: path.join(store, 'top.md') });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, 'not-index');
  });
});

describe('索引闸门：上限判定', () => {
  it('在上限内放行', () => {
    const store = makeStore();
    const r = check({ storePath: store, filePath: path.join(store, 'MEMORY.md'), content: lines(10) });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, undefined);
  });

  it('超过行数上限就拒绝，理由里要带上真实数字', () => {
    const store = makeStore();
    const r = check({
      storePath: store,
      filePath: path.join(store, 'MEMORY.md'),
      content: lines(DEFAULT_MAX_INDEX_LINES + 5),
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, new RegExp(String(DEFAULT_MAX_INDEX_LINES + 5)));
    assert.match(r.reason, new RegExp(String(DEFAULT_MAX_INDEX_LINES)));
  });

  it('超过字节上限也拒绝（行数没超时）', () => {
    const store = makeStore();
    const fat = Array.from({ length: 20 }, () => 'x'.repeat(2000)).join('\n');
    assert.ok(countLines(fat) < DEFAULT_MAX_INDEX_LINES, '行数不该超，否则测的不是字节那条');
    const r = check({ storePath: store, filePath: path.join(store, 'MEMORY.md'), content: fat });
    assert.equal(r.ok, false);
    assert.match(r.reason, /字节 >/);
  });

  it('上限可配', () => {
    const store = makeStore();
    const filePath = path.join(store, 'MEMORY.md');
    assert.equal(check({ storePath: store, filePath, content: lines(20) }).ok, true);
    const strict = check({ storePath: store, filePath, content: lines(20), maxLines: 5, maxBytes: 1024 });
    assert.equal(strict.ok, false);
  });
});

describe('索引闸门：缩小的重写永远放行（这道例外是唯一的出路）', () => {
  it('当前文件已超标时，写一份更小的必须放行 —— 否则闸门把自己锁死', () => {
    const store = makeStore();
    const filePath = path.join(store, 'MEMORY.md');
    // 先把库里的索引造成严重超标的样子（直接落盘，绕过闸门）
    writeFileSync(filePath, lines(DEFAULT_MAX_INDEX_LINES + 80));
    const grown = check({ storePath: store, filePath, content: lines(DEFAULT_MAX_INDEX_LINES + 120) });
    assert.equal(grown.ok, false, '继续长大必须被拒');
    const shrunk = check({ storePath: store, filePath, content: lines(DEFAULT_MAX_INDEX_LINES - 40) });
    assert.equal(shrunk.ok, true, '缩小必须放行');
  });

  it('缩小但**仍未降到上限以内**也放行 —— 要允许一步步压', () => {
    const store = makeStore();
    const filePath = path.join(store, 'MEMORY.md');
    writeFileSync(filePath, lines(400));
    const step = check({ storePath: store, filePath, content: lines(320) });
    assert.equal(step.ok, true, '320 行仍超 200，但比 400 小，得放行');
  });

  it('同尺寸放行 —— 判据是「比当前**大**」而不是「超限」（不长大就没让它更糟）', () => {
    const store = makeStore();
    const filePath = path.join(store, 'MEMORY.md');
    writeFileSync(filePath, lines(300));
    const same = check({ storePath: store, filePath, content: lines(300) });
    assert.equal(same.ok, true);
    // 但只要多一行，方向就反了
    const grew = check({ storePath: store, filePath, content: lines(301) });
    assert.equal(grew.ok, false);
  });

  it('库里还没有这份索引时，写一份超标的直接拒（没有「变小」可言）', () => {
    const store = makeStore();
    const r = check({
      storePath: store,
      filePath: path.join(store, 'MEMORY.md'),
      content: lines(DEFAULT_MAX_INDEX_LINES + 1),
    });
    assert.equal(r.ok, false);
  });
});

describe('索引闸门：edit 要按替换后的结果算', () => {
  it('只改一行的 edit 在上限内放行', () => {
    const store = makeStore();
    mkdirSync(store, { recursive: true });
    const filePath = path.join(store, 'MEMORY.md');
    writeFileSync(filePath, lines(10));
    const r = check({
      storePath: store,
      filePath,
      tool: 'edit',
      oldString: '- note-3.md — 第 3 行',
      newString: '- note-3.md — 第 3 行（改过）',
      content: undefined,
    });
    assert.equal(r.ok, true);
  });

  it('edit 把索引顶过上限 → 拒', () => {
    const store = makeStore();
    const filePath = path.join(store, 'MEMORY.md');
    writeFileSync(filePath, lines(DEFAULT_MAX_INDEX_LINES));
    const r = check({
      storePath: store,
      filePath,
      tool: 'edit',
      oldString: '- note-0.md — 第 0 行',
      newString: Array.from({ length: 30 }, (_, i) => `- 新增-${i}.md`).join('\n'),
      content: undefined,
    });
    assert.equal(r.ok, false);
  });

  it('edit 缩小超标索引 → 放行（与 write 同一条例外）', () => {
    const store = makeStore();
    const filePath = path.join(store, 'MEMORY.md');
    writeFileSync(filePath, lines(400));
    const r = check({
      storePath: store,
      filePath,
      tool: 'edit',
      oldString: lines(400).split('\n').slice(0, 200).join('\n'),
      newString: '- 就剩这一行了',
      content: undefined,
    });
    assert.equal(r.ok, true);
  });
});

describe('索引闸门：edit 传不出可还原的参数时（诚实打折，但别把路堵死）', () => {
  it('没有 old_string 就无法预测结果：索引没超限时放行（skipped: unmeasurable）', () => {
    const store = makeStore();
    const filePath = path.join(store, 'MEMORY.md');
    writeFileSync(filePath, lines(10));
    const r = check({ storePath: store, filePath, tool: 'edit', oldString: undefined, newString: 'x' });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, 'unmeasurable', '还原不出结果时要说清楚「这次没量」');
  });

  it('索引**已经**超限而这次编辑又还原不出来 → 拒绝盲改，并给出出口（缩小的重写永远放行）', () => {
    const store = makeStore();
    const filePath = path.join(store, 'MEMORY.md');
    writeFileSync(filePath, lines(400)); // 已经 400 行，远超 200
    const r = check({ storePath: store, filePath, tool: 'edit', oldString: '', newString: lines(401) });
    assert.equal(r.ok, false, '已经超限的索引不许再盲改 —— 结果不可预测时不能赌它不会更大');
    assert.match(r.reason, /拒绝盲改索引/);
    assert.match(r.reason, /当前已超上限/);
    assert.match(r.reason, /超过 200 行|200/, '理由里要带上真实数字');
    assert.match(r.reason, /缩小的重写永远放行/, '只说「先压缩」而不说怎么压，等于把路堵死');
  });
});

describe('索引闸门：量尺本身', () => {
  it('countLines 末尾换行不敏感', () => {
    assert.equal(countLines(''), 0);
    assert.equal(countLines('a'), 1);
    assert.equal(countLines('a\n'), 1, '末尾那一个换行不另算一行');
    assert.equal(countLines('a\nb'), 2);
    // 空行是行：三个换行 = 三行空白。这与 dsh-engramory 的算法逐字一致，
    // 两边算出来的数必须一样，否则同一个索引在两次检查里会有两个高度。
    assert.equal(countLines('\n\n\n'), 3);
  });

  it('measureIndex 没超返回 null，超了返回可读描述', () => {
    assert.equal(measureIndex('a\nb', DEFAULT_MAX_INDEX_LINES, DEFAULT_MAX_INDEX_BYTES), null);
    const overLines = measureIndex(lines(DEFAULT_MAX_INDEX_LINES + 2), DEFAULT_MAX_INDEX_LINES, DEFAULT_MAX_INDEX_BYTES);
    assert.match(overLines, new RegExp(`${DEFAULT_MAX_INDEX_LINES + 2} 行 > ${DEFAULT_MAX_INDEX_LINES}`));
    const fat = 'x'.repeat(DEFAULT_MAX_INDEX_BYTES + 10);
    assert.match(measureIndex(fat, DEFAULT_MAX_INDEX_LINES, DEFAULT_MAX_INDEX_BYTES), /字节 >/);
  });
});
