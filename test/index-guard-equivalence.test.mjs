/**
 * 索引闸门的**等价性黄金测试**。
 *
 * 这份用例存在的理由：`index-guard.js` 原来是从上游 DSH 适配器逐字移植来的，
 * 现在换成了我们自己重写的实现。重写最难保证的不是「跑得过」，而是**判定语义一个字节都没变**
 * —— 尤其是「缩小的重写永远放行」那条例外，它看着像后门，实际是唯一的出路：索引一旦超限，
 * 若不做例外，任何写入都被拒，就没有任何一次写入能让它降下来，闸门会把自己锁死。
 *
 * 证明方式：矩阵（`test/fixtures/index-guard-matrix.mjs`）里的每一条，都拿**改写前实现**
 * 跑过一遍，结果固化成 `test/fixtures/index-guard-equivalence.json`。这里把同一批输入喂给
 * 现在的实现，逐条全等比对 `{ ok / skipped / reason / countLines / measureIndex / 文件字节 }`
 * —— 快照是判据，不是「跑一遍看看」。
 *
 * 这份快照取自移植版实现（commit 821872ac888b92625656448901a1eaa8a6db71d，见 git log），
 * 用来证明重写是行为等价的。夹具本身的来源与口径写在矩阵文件与快照的 `$comment` 里。
 *
 * 矩阵里刻意**没有**的用例（写在这里，免得以后有人以为漏了）：
 *  - `str_replace_editor` / `old_str` / `new_str` 那套参数形状：本宿主用的是
 *    `write` / `edit` + `old_string` / `new_string`，搬一套用不上的分支是纯负担；
 *  - `indexName` 配置项：本插件知道库在哪，索引路径直接由 `storePath` 推出
 *    （`<storePath>/MEMORY.md`），不需要人手钉一个绝对路径。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import * as guard from '../index-guard.js';
import { CASES, materialize, seedBytes } from './fixtures/index-guard-matrix.mjs';

const SNAPSHOT = JSON.parse(readFileSync(new URL('./fixtures/index-guard-equivalence.json', import.meta.url), 'utf8'));
const SNAPSHOT_CASES = SNAPSHOT.cases;

const roots = [];
function makeRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'eng-index-equiv-'));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function seed(testCase, root) {
  const bytes = seedBytes(testCase);
  if (bytes === undefined) return;
  const args = materialize(testCase, root);
  mkdirSync(path.dirname(args.filePath), { recursive: true });
  writeFileSync(args.filePath, bytes);
}

function readOrNull(filePath) {
  try {
    return readFileSync(filePath);
  } catch {
    return null;
  }
}

function resetRoot(root) {
  for (const sub of ['store', 'outside', 'notes']) rmSync(path.join(root, sub), { recursive: true, force: true });
}

/** 跑一条矩阵用例，返回「对外可见的全部结果」。 */
function run(testCase, root) {
  const args = materialize(testCase, root);
  resetRoot(root);
  seed(testCase, root);
  const before = readOrNull(args.filePath);
  const result = guard.checkIndexWrite(args);
  const after = readOrNull(args.filePath);
  const text = typeof args.content === 'string' ? args.content : undefined;
  return {
    args,
    result,
    after,
    countLines: text === undefined ? undefined : guard.countLines(text),
    measureIndex:
      text === undefined
        ? undefined
        : guard.measureIndex(text, args.maxLines ?? guard.DEFAULT_MAX_INDEX_LINES, args.maxBytes ?? guard.DEFAULT_MAX_INDEX_BYTES),
    before,
  };
}

/** 快照里记录的那条用例的期望（键与顺序都固定，比对的是对外形状）。 */
function expectedOf(id) {
  const record = SNAPSHOT_CASES[id];
  return {
    result: {
      ok: record.ok,
      ...(record.skipped === undefined ? {} : { skipped: record.skipped }),
      ...(record.reason === undefined ? {} : { reason: record.reason }),
    },
    countLines: record.countLines,
    measureIndex: record.measureIndex,
    fileAfterCallBytes: record.fileAfterCallBytes,
  };
}

describe('索引闸门等价性：矩阵规模与夹具自洽', () => {
  it('矩阵条数与快照条数一致，且每条都能在快照里找到', () => {
    assert.equal(SNAPSHOT.caseCount, CASES.length, '快照里的 caseCount 与矩阵对不上，说明有一边改了没同步');
    for (const testCase of CASES) {
      assert.ok(SNAPSHOT_CASES[testCase.id], `矩阵用例 ${testCase.id} 在快照里没有记录`);
      assert.ok(typeof SNAPSHOT_CASES[testCase.id].note === 'string' && SNAPSHOT_CASES[testCase.id].note.length > 0, `${testCase.id} 缺 note`);
    }
    assert.equal(Object.keys(SNAPSHOT_CASES).length, CASES.length, '快照里有多余的用例（矩阵删了用例但没重生成快照？）');
  });

  it('快照记下了它的来源：移植版实现的 commit', () => {
    assert.match(SNAPSHOT.$comment, /移植版实现/);
    assert.equal(SNAPSHOT.sourceCommit, '821872ac888b92625656448901a1eaa8a6db71d');
    assert.deepEqual(SNAPSHOT.defaults, { maxLines: 200, maxBytes: 25600 });
  });
});

describe('索引闸门等价性：逐条复现改写前实现的判定', () => {
  for (const testCase of CASES) {
    it(`${testCase.id} —— ${testCase.note}`, () => {
      const root = makeRoot();
      const run1 = run(testCase, root);
      const expected = expectedOf(testCase.id);

      assert.deepEqual(run1.result, expected.result, `${testCase.id}: 判定结果与改写前不一致`);
      if (expected.countLines !== undefined) {
        assert.equal(run1.countLines, expected.countLines, `${testCase.id}: countLines 与改写前不一致`);
        assert.equal(run1.measureIndex, expected.measureIndex, `${testCase.id}: measureIndex 与改写前不一致`);
      }
      // 闸门只负责「判」，绝不落盘：跑完之后文件必须一个字节都没变。
      const same = (a, b) => (a === null && b === null) || (a !== null && b !== null && a.equals(b));
      assert.ok(same(run1.before, run1.after), `${testCase.id}: 守卫改动了文件（它只该判定）`);
      assert.equal(run1.after === null ? null : run1.after.length, expected.fileAfterCallBytes, `${testCase.id}: 跑完之后文件的有无/字节数变了`);
    });
  }
});

describe('索引闸门等价性：对外承诺的接口形状', () => {
  const exported = {
    DEFAULT_MAX_INDEX_LINES: 200,
    DEFAULT_MAX_INDEX_BYTES: 25600,
  };
  for (const [name, value] of Object.entries(exported)) {
    it(`导出 ${name} = ${value}`, () => {
      assert.equal(guard[name], value);
    });
  }

  it('公开导出只有这三个函数 + 两个常量（多出来的是接口扩张，要有意识地为它写用例）', () => {
    const names = Object.keys(guard).sort();
    assert.deepEqual(names, [
      'DEFAULT_MAX_INDEX_BYTES',
      'DEFAULT_MAX_INDEX_LINES',
      'checkIndexWrite',
      'countLines',
      'measureIndex',
    ]);
  });

  it('countLines 与快照口径一致：末尾换行不敏感、空行算行', () => {
    assert.equal(guard.countLines(''), 0);
    assert.equal(guard.countLines('a'), 1);
    assert.equal(guard.countLines('a\n'), 1);
    assert.equal(guard.countLines('a\nb'), 2);
    assert.equal(guard.countLines('\n\n\n'), 3);
  });
});
