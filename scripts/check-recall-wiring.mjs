#!/usr/bin/env node
/**
 * check-recall-wiring.mjs —— dsh-engramory-recall 装上之后的“它真的在工作吗”自检。
 *
 * 为什么需要它：这个插件有五种**静默失效**——不报错，只是从此不干活。
 *   1. 配置键打错字（`storePathh`）：宿主忽略未知键，插件退回内置默认值 `storePath: ''`，
 *      而空路径是刻意的安全默认 —— 一个 token 都不再注入，日志里也没有一句话；
 *   2. `storePath` 指到不存在的目录：readDocs 返回空数组，召回率恒为 0；
 *   3. profile 里跑的不是你正在改的那份（软链断了、或装成了 npm 上的旧版）：
 *      测试全绿，加载的是别人的代码；
 *   4. `package.json` 的 `files` 白名单漏文件：本地怎么跑都对，装出去少一个入口
 *      （`npm pack --dry-run` 只列清单、不加载代码，所以 CI 也发现不了）；
 *   5. 这一行被 `enabled: false` 关掉了，而你以为它还开着。
 *
 * 本脚本做静态复核 + 跑单测（宿主接口金丝雀）。**它不能代替活体守卫测试**：
 * 守卫挂在 `ctx.tools.guard` 上、只拦 write/edit 工具调用，脚本自己写盘会绕过去，
 * 所以最后一段打印的是必须由 agent 亲手做的步骤。
 *
 * 用法：node scripts/check-recall-wiring.mjs [--profile desktop] [--skip-tests]
 * 退出码：0 = 全部通过；1 = 有需要处理的问题（输出里带 ✗ / ⚠）。
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = homedir();
const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh');
const PLUGIN_NAME = 'dsh-engramory-recall';

const args = process.argv.slice(2);
const profile = valueOf('--profile') ?? 'desktop';
const skipTests = args.includes('--skip-tests');

const problems = [];
const notes = [];
const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => { problems.push(msg); console.log(`  ⚠ ${msg}`); };
const bad = (msg) => { problems.push(msg); console.log(`  ✗ ${msg}`); };

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/**
 * 最小 YAML 读取：只抽「每个 `id:` 行 + 它的 name + 它下面 `config:` 块的键」。
 * 不认识的结构返回空数组，由调用方判定为“解析不了”，而不是“没问题”。
 */
function parseRows(text) {
  const rows = [];
  let current = null;
  let inConfig = false;
  let configIndent = -1;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.search(/\S/);
    const idMatch = trimmed.match(/^-?\s*id:\s*(.+?)\s*$/);
    if (idMatch) {
      current = { id: idMatch[1].replace(/^["']|["']$/g, ''), name: undefined, keys: [], config: {} };
      rows.push(current);
      inConfig = false;
      continue;
    }
    if (current && !current.name) {
      const nameMatch = trimmed.match(/^name:\s*(.+?)\s*$/);
      if (nameMatch) current.name = nameMatch[1].replace(/^["']|["']$/g, '');
    }
    if (current && /^config:\s*$/.test(trimmed)) {
      inConfig = true;
      configIndent = indent;
      continue;
    }
    if (current && inConfig) {
      if (indent <= configIndent) { inConfig = false; continue; }
      const kv = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(.*?)\s*$/);
      if (kv) {
        current.keys.push(kv[1]);
        current.config[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
      }
    }
  }
  return rows;
}

/** 插件真正会读的配置键：DEFAULTS 里的 + 代码里 `settings.X` 出现过的。 */
function readConfigKeys(indexSource) {
  const keys = new Set();
  const defaults = indexSource.match(/const DEFAULTS = \{([\s\S]*?)\n\};/);
  if (defaults) {
    for (const m of defaults[1].matchAll(/^ {2}([A-Za-z0-9_]+):/gm)) keys.add(m[1]);
  }
  for (const m of indexSource.matchAll(/settings\.([A-Za-z0-9_]+)/g)) keys.add(m[1]);
  return keys;
}

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? join(HOME, p.slice(2)) : p);

console.log(`${PLUGIN_NAME} 接线自检  ·  profile=${profile}  ·  DSH_HOME=${DSH_HOME}\n`);

// ── 0. 路径 ────────────────────────────────────────────────────────────────
const profileDir = join(DSH_HOME, 'profiles', profile);
const pluginDir = join(profileDir, 'node_modules', PLUGIN_NAME);
const profilePatchPath = join(profileDir, 'cordis.patch.yml');

if (!existsSync(pluginDir)) bad(`profile 里没有这个插件：${pluginDir}（先 dsh plugin --profile ${profile} add ${PLUGIN_NAME}）`);
if (!existsSync(join(PKG_DIR, 'package.json'))) bad(`当前目录不像插件仓库：${PKG_DIR}`);
if (problems.length) {
  console.log('\n结论：路径都不对，先确认 profile 名（--profile <name>）与工作目录。');
  process.exit(1);
}

// ── 1. profile 里跑的到底是哪一份 ─────────────────────────────────────────
console.log('1) 跑的是哪一份');
const repoPkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
const installedPkgPath = join(pluginDir, 'package.json');
let installedPkg = {};
try { installedPkg = JSON.parse(readFileSync(installedPkgPath, 'utf8')); } catch { /* 下面统一判 */ }
if (!installedPkg.version) bad(`读不到已安装版本的 package.json：${installedPkgPath}`);

const linkTarget = lstatSync(pluginDir).isSymbolicLink() ? realpathSync(pluginDir) : undefined;
if (linkTarget && linkTarget === realpathSync(PKG_DIR)) {
  ok(`软链到本仓库（${linkTarget}）—— 改这边、重启 App 即生效`);
} else if (linkTarget) {
  warn(`profile 跑的是 ${linkTarget}，不是本仓库 —— 你在这边改的东西不会生效`);
} else {
  notes.push(`profile 里是独立安装的副本（不是软链）—— 它可能是 npm 上任何一个版本：${installedPkg.version}`);
}
if (installedPkg.version && installedPkg.version !== repoPkg.version) {
  warn(`版本不一致：profile=${installedPkg.version} 仓库=${repoPkg.version}`);
} else if (installedPkg.version) {
  ok(`版本一致：${installedPkg.version}`);
}

// ── 2. 配置：唯一会静默失效的地方 ─────────────────────────────────────────
console.log('\n2) 配置有没有被改坏');
const indexSource = readFileSync(join(pluginDir, 'index.js'), 'utf8');
const readKeys = readConfigKeys(indexSource);
const patchPath = join(pluginDir, 'cordis.patch.yml');
const ourRow = existsSync(patchPath)
  ? parseRows(readFileSync(patchPath, 'utf8')).find((row) => row.name === PLUGIN_NAME || row.id === 'engramory-recall')
  : undefined;

let storePath;
if (!ourRow) {
  bad(`插件自带的 cordis.patch.yml 里找不到注册行（name: ${PLUGIN_NAME}）—— 插件根本不会被加载`);
} else {
  ok(`注册行在：id=${ourRow.id}，带 ${ourRow.keys.length} 个配置键`);
  const unknown = ourRow.keys.filter((key) => !readKeys.has(key));
  if (unknown.length) {
    bad(`这些键宿主不认识、会被静默忽略：${unknown.join(', ')}（打错一个字就等于没配 —— 例如 storePath 拼错会退回空路径，插件从此一句话都不注入）`);
  } else {
    ok('所有配置键都能在 index.js 里找到对应读取处');
  }
  storePath = ourRow.config.storePath ? expandHome(ourRow.config.storePath) : '';
  if (ourRow.config.enabled === 'false') warn('这一行是 enabled: false —— 插件被关掉了，装着一个字也不会注入');
  if (!readKeys.has('storePath')) warn('index.js 里已经读不到 storePath 了（键被改名？），而 patch 还在配它');
}

if (existsSync(profilePatchPath)) {
  const override = parseRows(readFileSync(profilePatchPath, 'utf8')).find((row) => row.name === PLUGIN_NAME || row.id === 'engramory-recall');
  if (override) {
    const unknown = override.keys.filter((key) => !readKeys.has(key));
    unknown.length
      ? bad(`profile 覆盖里有 index.js 不认识的键：${unknown.join(', ')}`)
      : ok(`profile 覆盖的键都认得（${override.keys.join(', ') || '空'}）—— 注意 patch 是整段替换 config，没重述的键会落回内置默认值`);
  } else {
    notes.push('profile patch 没有覆盖我们这一行：配置全部来自插件自带的默认值（升级时不会失配，但也无法按 profile 定制）');
  }
}

// ── 3. 库路径真的指到东西了吗 ─────────────────────────────────────────────
console.log('\n3) 记忆库');
if (!storePath) {
  bad('storePath 读出来是空的 —— 空路径是安全默认（不工作也不报错），库在哪就没人知道了');
} else if (!existsSync(storePath)) {
  bad(`storePath 指向的目录不存在：${storePath}`);
} else {
  const indexPath = join(storePath, 'MEMORY.md');
  const notes_ = readdirSync(storePath).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  if (!existsSync(indexPath)) {
    bad(`库里没有索引文件：${indexPath}（守卫与召回都以它为中心）`);
  } else {
    const bytes = statSync(indexPath).size;
    const text = readFileSync(indexPath, 'utf8');
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    ok(`storePath = ${storePath}（${notes_.length} 篇笔记 + MEMORY.md ${lines} 行 / ${bytes} 字节）`);
    try {
      const ig = await import(pathToFileURL(join(pluginDir, 'index-guard.js')).href);
      const maxLines = ig.DEFAULT_MAX_INDEX_LINES;
      const maxBytes = ig.DEFAULT_MAX_INDEX_BYTES;
      if (lines > maxLines || bytes > maxBytes) {
        warn(`索引已经超过上限（${lines}/${maxLines} 行、${bytes}/${maxBytes} 字节）—— 从此任何增长都会被守卫拒绝，只能靠重写缩小`);
      } else if (lines > maxLines * 0.9 || bytes > maxBytes * 0.9) {
        notes.push(`索引已用掉 ${Math.round((lines / maxLines) * 100)}% 行 / ${Math.round((bytes / maxBytes) * 100)}% 字节，快到头了`);
      } else {
        ok(`索引余量充足（行 ${lines}/${maxLines}、字节 ${bytes}/${maxBytes}）`);
      }
    } catch (error) {
      warn(`读不到 index-guard.js 的上限常量（${error?.message ?? error}）`);
    }
  }
}

// ── 4. 宿主接口面：装出去会不会少东西 ─────────────────────────────────────
console.log('\n4) 发布面（漏文件是静默失效）');
const missingFiles = (repoPkg.files ?? []).filter((rel) => !existsSync(join(PKG_DIR, rel)));
missingFiles.length
  ? bad(`package.json 的 files 白名单里有不存在的路径：${missingFiles.join(', ')}（npm 会静默跳过）`)
  : ok(`files 白名单 ${(repoPkg.files ?? []).length} 项都在`);
const exportsMap = repoPkg.exports ?? {};
const missingExports = Object.entries(exportsMap)
  .map(([, value]) => (typeof value === 'string' ? value : undefined))
  .filter((rel) => rel && !existsSync(join(PKG_DIR, rel)));
missingExports.length
  ? bad(`exports 指向不存在的文件：${missingExports.join(', ')}`)
  : ok(`exports ${Object.keys(exportsMap).length} 个入口都在`);
for (const rel of ['client/client.js', 'llm.js', 'index-guard.js']) {
  if (!existsSync(join(PKG_DIR, rel))) bad(`缺文件：${rel}`);
  else if (!(repoPkg.files ?? []).includes(rel)) bad(`${rel} 存在但不在 files 白名单里 —— 装出去就没有它`);
}
// 语法门：客户端 bundle 写坏了，宿主会在加载时丢掉整个客户端半侧（面板不出现、且不报错）。
const syntaxBroken = [];
for (const rel of ['index.js', 'client/client.js', 'llm.js', 'bm25.js', 'store.js', 'guard.js', 'index-guard.js']) {
  const check = spawnSync(process.execPath, ['--check', join(PKG_DIR, rel)], { encoding: 'utf8' });
  if (check.status !== 0) {
    const firstLine = String(check.stderr ?? '').split('\n').find((line) => line.trim()) ?? '语法错误';
    syntaxBroken.push(`${rel}（${firstLine.trim()}）`);
  }
}
syntaxBroken.length
  ? bad(`语法不过 node --check：${syntaxBroken.join('、')}`)
  : ok('客户端 bundle 与运行时入口都过 node --check');

// ── 5. 单测：宿主接口的金丝雀 ─────────────────────────────────────────────
console.log('\n5) 单测（宿主接口没变才跑得绿）');
if (skipTests) {
  notes.push('本次跳过单测（--skip-tests）');
} else {
  const testFiles = readdirSync(join(PKG_DIR, 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => join('test', f));
  const run = spawnSync(process.execPath, ['--test', ...testFiles], { cwd: PKG_DIR, encoding: 'utf8' });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const pass = Number(out.match(/^# pass (\d+)$/m)?.[1] ?? out.match(/ℹ pass (\d+)/)?.[1] ?? -1);
  const fail = Number(out.match(/^# fail (\d+)$/m)?.[1] ?? out.match(/ℹ fail (\d+)/)?.[1] ?? -1);
  if (run.status === 0 && fail === 0) ok(`${testFiles.length} 个测试文件全绿（${pass} 例）—— 宿主接口没变`);
  else bad(`单测未通过（pass=${pass} fail=${fail}）—— 宿主接口可能变了，看上面的输出`);
}

// ── 6. 活体守卫测试（脚本做不了）──────────────────────────────────────────
console.log('\n6) 活体守卫测试（脚本做不了，必须让 agent 用 write 工具触发）');
console.log('   守卫只拦 write / edit 这类工具调用；脚本直接写盘会绕过它。两个方向都要测：');
console.log('     a. **库外**放行：在工作区建一个 202 行的 MEMORY.md，让 agent 用 write 覆盖它');
console.log('        —— 期望放行（说明守卫钉在 storePath 上，不是按文件名满世界拦）；');
console.log('     b. **库内**拦下：把真索引写到 201 行以上再让 agent 追加一行');
console.log('        —— 期望被拒（报“超过 200 行”）；测完把索引恢复原样（先备份）。');

// ── 结论 ──────────────────────────────────────────────────────────────────
if (notes.length) {
  console.log('\n备注');
  for (const note of notes) console.log(`  · ${note}`);
}
console.log(
  problems.length
    ? `\n结论：${problems.length} 项需要处理（见上面 ✗/⚠）。`
    : '\n结论：接线全部正常 —— 装上之后是真的在工作。',
);
process.exit(problems.length ? 1 : 0);
