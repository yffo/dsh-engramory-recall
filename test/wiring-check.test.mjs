import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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

/** patchEdit 里要往「被检仓库」写东西（例如放一个假提供方），用它拿到那个目录。 */
let lastRepoDir = '';
const fxRepoDir = () => lastRepoDir;

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

  lastRepoDir = repo;
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

/**
 * 这台机器上有没有正在跑的 DSH 进程？
 * 「旧代码检测」那两条用例需要它：CI 上没有 App 在跑，那条规则整段跳过 —— 不是代码坏了。
 */
function hasDshProcess() {
  const ps = spawnSync('ps', ['-axo', 'lstart=,command='], { encoding: 'utf8' });
  return String(ps.stdout ?? '')
    .split('\n')
    .some((l) => /DeepSeek Harness\.app\/Contents\/MacOS\/DeepSeek Harness(\s|$)/.test(l) || /dsh\s+web/.test(l));
}

/** 把「被检仓库」里的运行时文件统一改成某个时刻（旧代码检测那两条用例要用）。 */
function stampRuntimeFiles(repo, ms) {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const files = (pkg.files ?? [])
    .filter((f) => typeof f === 'string' && /\.(?:js|mjs)$/.test(f) && !f.startsWith('scripts/'));
  for (const f of files) {
    try {
      utimesSync(join(repo, f), new Date(ms), new Date(ms));
    } catch { /* 清单里可能有别的平台的条目，跳过 */ }
  }
  return files;
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

test('语义接缝：配了真提供方就活体探一次（假提供方也能证明这条路是通的）', () => {
  const fx = makeFixture({
    patchEdit: (p) => {
      // 假提供方写在被检仓库里，用相对路径指它 —— 走的是和真提供方一样的 loadProvider 路径。
      writeFileSync(
        join(fxRepoDir(p), 'fake-provider.mjs'),
        "export const name = 'fake' ;\nexport function rerank({ docs }) { return docs.map((d) => d.id).reverse(); }\n",
      );
      return p.replace(
        '        enabled: true',
        `        enabled: true\n        semanticProvider: '${join(fxRepoDir(p), 'fake-provider.mjs')}'\n        semanticPool: 3`,
      );
    },
  });
  try {
    const { out } = run(fx);
    assert.match(out, /2b\) 语义接缝/);
    assert.match(out, /接缝活着：.*fake-provider\.mjs 真的答了/, out);
  } finally {
    fx.cleanup();
  }
});

test('语义接缝：配了但提供方不存在，要说清是哪一种坏法（不是一句“配置错误”）', () => {
  const fx = makeFixture({
    patchEdit: (p) => p.replace('        enabled: true', "        enabled: true\n        semanticProvider: './nope-provider.mjs'"),
  });
  try {
    const { out } = run(fx);
    assert.match(out, /接缝配了但这次用不上：code=not-found/, out);
  } finally {
    fx.cleanup();
  }
});

test('语义接缝：相对路径要提醒（脚本的 cwd 与 App 的 cwd 不一定一样）', () => {
  const fx = makeFixture({
    patchEdit: (p) => p.replace('        enabled: true', "        enabled: true\n        semanticProvider: './fake-provider.mjs'"),
  });
  try {
    const { out } = run(fx);
    assert.match(out, /按\*\*进程 cwd\*\*\s*解析/, out);
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

test('旧代码检测：整份运行时文件都比 App 旧时，明确说「跑的就是当前这份」', (t) => {
  if (!hasDshProcess()) return t.skip('这台机器上没有跑着的 DSH 进程（CI 上就是这样）');
  const fx = makeFixture();
  try {
    stampRuntimeFiles(fx.repo, Date.now() - 30 * 24 * 3600 * 1000);
    const { out } = run(fx);
    assert.match(out, /DSH 进程比仓库代码新/, out);
  } finally {
    fx.cleanup();
  }
});

test('旧代码检测：不只看 index.js/semantic.js —— 任何一个运行时文件比 App 新都要报', (t) => {
  if (!hasDshProcess()) return t.skip('这台机器上没有跑着的 DSH 进程（CI 上就是这样）');
  const fx = makeFixture({
    patchEdit: (p) => p.replace('        enabled: true', "        enabled: true\n        semanticProvider: 'dsh-engramory-recall/providers/openai-embeddings'"),
  });
  try {
    stampRuntimeFiles(fx.repo, Date.now() - 30 * 24 * 3600 * 1000);
    // 只动 usage.js（它曾经漏在检测名单外：改了它 App 里跑的还是旧模块）
    const future = Date.now() + 60_000;
    utimesSync(join(fx.repo, 'usage.js'), new Date(future), new Date(future));
    const { code, out } = run(fx);
    assert.match(out, /DSH 进程比仓库代码旧/, out);
    assert.equal(code, 1, '接缝开着时这是要处理的问题');
  } finally {
    fx.cleanup();
  }
});
