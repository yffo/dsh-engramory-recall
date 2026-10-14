import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * 公开基准的 harness 也要有测试。
 *
 * 真数据集（LongMemEval-S cleaned 264MB）不可能进 CI，所以这里用一份**同格式的小夹具**
 * 守住两件事：
 *   1) 口径没被悄悄改动 —— 夹具里四道题分别覆盖「命中 / 中文命中 / 多 gold 只找到一半 / 零字面重叠必失手」，
 *      四个数字（75% / 75% / 62.5% / 0.75）是这套口径的指纹，动了判据它们就变；
 *   2) 两个开关（`--engine`、`--limit`）与缺文件时的退出码都还在。
 *
 * 注意：夹具是**我们造的数据**，只用来测 harness 本身，不构成任何"效果"声明 ——
 * 效果数字来自真数据集，见 README 里那一节。
 */
const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = 'bench/fixtures/longmemeval-mini.json';
const RESULT = join(PKG_DIR, 'bench', '.tmp', 'longmemeval-result.json');

function runHarness(args) {
  return execFileSync(process.execPath, ['bench/longmemeval.mjs', ...args], {
    cwd: PKG_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readResult() {
  return JSON.parse(readFileSync(RESULT, 'utf8'));
}

test('夹具跑出的四个数字与口径指纹一致', () => {
  const out = runHarness(['--data', FIXTURE, '--json']);
  const r = readResult();

  assert.equal(r.总表.n, 4);
  assert.equal(r.总表.recallAny1, 0.75, 'RecallAny@1 变了：先确认是引擎退化还是判据被改');
  assert.equal(r.总表.recallAnyK, 0.75);
  assert.equal(r.总表.recallK, 0.625, 'Recall@5 覆盖了 gold：一题两个 gold 只找到一个是 0.5');
  assert.equal(r.总表.mrr, 0.75);

  // 报告里必须打出真实数据集名与 sha，不能是写死的字符串
  assert.match(out, /数据集 longmemeval-mini\.json · sha256 前 12 位 `[0-9a-f]{12}`/);
});

test('夹具四种结果各自成立（含「零字面重叠必失手」这条）', () => {
  runHarness(['--data', FIXTURE, '--json']);
  const byId = Object.fromEntries(readResult().逐题.map((r) => [r.question_id, r]));

  assert.deepEqual(
    Object.keys(byId).sort(),
    ['mini-1', 'mini-2', 'mini-3', 'mini-4'],
  );
  assert.equal(byId['mini-1'].hit1, true, '英文题应该榜一');
  assert.equal(byId['mini-2'].hit1, true, '中文题应该榜一');
  assert.equal(byId['mini-3'].recallK, 0.5, '两个 gold 只该找到一个');
  assert.equal(byId['mini-3'].hitK, true);
  assert.equal(byId['mini-4'].hitK, false, '零字面重叠的题不该被「找到」——找得到说明判据漏了东西');
  assert.equal(byId['mini-4'].rr, 0);

  // 每题的行形状也得对（gold 数、session 数都在里面）
  assert.equal(byId['mini-3'].gold, 2);
  assert.equal(byId['mini-3'].sessions, 8);
});

test('--engine 能换成教科书 BM25 基线，且两套引擎在夹具上同分（夹具只考字面）', () => {
  runHarness(['--data', FIXTURE, '--engine', 'unigram', '--json']);
  const base = readResult();
  assert.equal(base.总表.recallAnyK, 0.75);

  const out = runHarness(['--data', FIXTURE, '--engine', 'bigram']);
  assert.match(out, /基线：同分词口径的教科书 BM25/);
});

test('--limit 截断会写明在报告里', () => {
  const out = runHarness(['--data', FIXTURE, '--limit', '2', '--json']);
  assert.match(out, /题数 2（--limit 2 截断）/);
  assert.equal(readResult().逐题.length, 2);
});

test('数据文件不存在时以退出码 2 结束，而不是静默跑出 0 分', () => {
  assert.throws(
    () => runHarness(['--data', 'bench/fixtures/不存在的文件.json']),
    (err) => {
      assert.equal(err.status, 2, '缺数据必须是显式的 2，不能伪装成一次成功的测量');
      assert.match(String(err.stderr), /找不到数据集/);
      return true;
    },
  );
});
