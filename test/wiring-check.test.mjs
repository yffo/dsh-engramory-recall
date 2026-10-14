import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * 自检脚本本身也要有测试 —— 它是发布前的最后一道门，门坏了比没门更糟：
 * 一个永远返回 0 的 check 会让人放心地发出版本缺文件的包。
 *
 * 做法：把仓库复制一份到临时目录当“被检对象”（**不碰真仓库**），
 * profile 里软链到这份副本，然后故意把配置/清单改坏，看它是否真的会红。
 */
const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function makeFixture({ patchEdit, pkgEdit } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wiring-check-'));
  const repo = join(home, 'repo');
  cpSync(PKG_DIR, repo, {
    recursive: true,
    filter: (src) => !/\/(\.git|node_modules|test|bench|\.tmp)(\/|$)/.test(src),
  });

  const store = join(home, 'store');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'MEMORY.md'), '# 索引\n');
  writeFileSync(join(store, 'reference-x.md'), '---\nname: x\n---\n正文\n');

  const patchPath = join(repo, 'cordis.patch.yml');
  let patch = readFileSync(patchPath, 'utf8').replace('~/memory/engramory', store);
  if (patchEdit) patch = patchEdit(patch, store);
  writeFileSync(patchPath, patch);

  if (pkgEdit) {
    const pkgPath = join(repo, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkgEdit(pkg);
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  const profileDir = join(home, 'profiles', 'desktop');
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true });
  symlinkSync(repo, join(profileDir, 'node_modules', 'dsh-engramory-recall'), 'dir');
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n');

  return { home, repo, store, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function run(fx) {
  try {
    const stdout = execFileSync(process.execPath, [join(fx.repo, 'scripts', 'check-recall-wiring.mjs'), '--skip-tests'], {
      env: { ...process.env, DSH_HOME: fx.home },
      encoding: 'utf8',
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

test('干净的接线：退出码 0，并报出库里有几篇笔记', () => {
  const fx = makeFixture();
  try {
    const { code, out } = run(fx);
    assert.equal(code, 0, out);
    assert.match(out, /接线全部正常/);
    assert.match(out, /1 篇笔记/);
  } finally {
    fx.cleanup();
  }
});

test('配置键打错字：必须变红 —— 这正是“插件从此一句话都不注入”的静默失效', () => {
  const fx = makeFixture({ patchEdit: (p) => p.replace('storePath:', 'storePathh:') });
  try {
    const { code, out } = run(fx);
    assert.equal(code, 1, out);
    assert.match(out, /storePathh/);
    assert.match(out, /静默忽略/);
  } finally {
    fx.cleanup();
  }
});

test('库路径不存在：必须变红（空库会把召回率静默地变成 0）', () => {
  const fx = makeFixture({ patchEdit: (p, store) => p.replace(store, join(store, 'nope')) });
  try {
    const { code, out } = run(fx);
    assert.equal(code, 1, out);
    assert.match(out, /不存在/);
  } finally {
    fx.cleanup();
  }
});

test('enabled: false 只提醒、不算失败（关掉是合法选择，但得让人看见）', () => {
  const fx = makeFixture({ patchEdit: (p) => p.replace('enabled: true', 'enabled: false') });
  try {
    const { out } = run(fx);
    assert.match(out, /enabled: false/);
  } finally {
    fx.cleanup();
  }
});

test('包清单与磁盘不一致：必须变红（装出去的包会少文件，而 CI 只列清单不加载）', () => {
  const fx = makeFixture({ pkgEdit: (pkg) => pkg.files.push('definitely-missing.js') });
  try {
    const { code, out } = run(fx);
    assert.equal(code, 1, out);
    assert.match(out, /definitely-missing\.js/);
  } finally {
    fx.cleanup();
  }
});

test('漏进 files 白名单的入口文件：必须变红（本地能跑、装出去没有）', () => {
  const fx = makeFixture({ pkgEdit: (pkg) => { pkg.files = pkg.files.filter((f) => f !== 'llm.js'); } });
  try {
    const { code, out } = run(fx);
    assert.equal(code, 1, out);
    assert.match(out, /不在 files 白名单/);
  } finally {
    fx.cleanup();
  }
});
