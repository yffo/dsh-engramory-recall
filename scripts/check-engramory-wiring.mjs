#!/usr/bin/env node
/**
 * check-engramory-wiring.mjs —— engramory 接线的“升级后自检”。
 *
 * 为什么需要它：profile 里的 `cordis.patch.yml` 对 engramory 那一行是**整段替换 config**
 * （上游 patch 自己的注释就写着 "must restate every key it means to keep"）。
 * 于是升级后有两种**静默失效**：
 *   1. 上游新增了 config 键 → 我们的覆盖不带它，它会落回插件内置默认值；
 *   2. 上游改了行 id 或键名 → 覆盖失配，守卫退回“按文件名匹配”，
 *      任何项目里的 MEMORY.md 都会被拦，而且不报任何错。
 *
 * 用法：
 *   node scripts/check-engramory-wiring.mjs [--profile desktop] [--skip-tests]
 *
 * 退出码：0 = 全部通过；1 = 有需要处理的问题（输出里带 ✗ / ⚠）。
 *
 * 注意：本脚本**不能**代替活体守卫测试——它自己写盘走的是文件系统，不经过 ctx.tools.guard()。
 * 脚本最后会打印活体测试的确切步骤（必须由 agent 用 write 工具触发）。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = homedir();
const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh');

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
 * 最小 YAML 读取：只抽「每个 `id:` 行 + 它下面 `config:` 块的键」，够用且不引依赖。
 * 结构不认识时返回空数组，由调用方判定为“无法解析”而不是“没问题”。
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
      current = { id: idMatch[1].replace(/^["']|["']$/g, ''), keys: [] };
      rows.push(current);
      inConfig = false;
      continue;
    }
    if (current && /^config:\s*$/.test(trimmed)) {
      inConfig = true;
      configIndent = indent;
      continue;
    }
    if (current && inConfig) {
      if (indent <= configIndent) { inConfig = false; continue; }
      const kv = trimmed.match(/^([A-Za-z0-9_.-]+):/);
      if (kv) current.keys.push(kv[1]);
    }
  }
  return rows;
}

console.log(`engramory 接线自检  ·  profile=${profile}  ·  DSH_HOME=${DSH_HOME}\n`);

// ── 0. 路径 ────────────────────────────────────────────────────────────────
const profileDir = join(DSH_HOME, 'profiles', profile);
const pluginDir = join(profileDir, 'node_modules', 'dsh-engramory');
const profilePatchPath = join(profileDir, 'cordis.patch.yml');

if (!existsSync(pluginDir)) bad(`找不到已安装的插件：${pluginDir}`);
if (!existsSync(profilePatchPath)) bad(`找不到 profile patch：${profilePatchPath}`);
if (problems.length) {
  console.log('\n结论：路径都不对，先确认 profile 名（--profile <name>）。');
  process.exit(1);
}

// ── 1. 已安装版本 ──────────────────────────────────────────────────────────
console.log('1) 版本');
const installedVersion = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version;
const declared = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    return pkg.dependencies?.['dsh-engramory'] ?? '(未声明)';
  } catch { return '(读取失败)'; }
})();
ok(`已安装 dsh-engramory ${installedVersion}（profile 声明 ${declared}）`);

// ── 2. 上游默认 config 键 vs 我们的覆盖 ────────────────────────────────────
console.log('\n2) 配置覆盖是否跟上上游');
const upstreamPatchPath = join(pluginDir, 'cordis.patch.yml');
const upstreamRows = existsSync(upstreamPatchPath)
  ? parseRows(readFileSync(upstreamPatchPath, 'utf8'))
  : [];
const upstreamRow = upstreamRows.find((row) => row.id === 'engramory');
const overrideRow = parseRows(readFileSync(profilePatchPath, 'utf8')).find((row) => row.id === 'engramory');

if (!upstreamRow) {
  bad('上游 patch 里已找不到 id: engramory —— 行 id 可能被改名，我们的覆盖会静默失配');
} else if (!overrideRow) {
  bad('profile patch 里没有 id: engramory 的覆盖 —— indexPath 没被钉住，守卫会拦任何 MEMORY.md');
} else {
  ok(`行 id 仍然匹配（上游 ${upstreamRow.keys.length} 个默认键，我们的覆盖 ${overrideRow.keys.length} 个键）`);
  const missing = upstreamRow.keys.filter((key) => !overrideRow.keys.includes(key));
  if (missing.length) {
    warn(`上游新增/改名了这些键，我们的覆盖没有带上，它们会落回插件内置默认值：${missing.join(', ')}`);
  } else {
    ok('上游的默认键都被我们显式重述了');
  }
  const extra = overrideRow.keys.filter((key) => !upstreamRow.keys.includes(key));
  if (extra.length) notes.push(`我们额外钉住的键：${extra.join(', ')}（上游默认没有，故意保留即可）`);
}

// ── 3. indexPath 是否指向真实记忆库 ────────────────────────────────────────
console.log('\n3) 守卫钉在哪');
const indexPath = (() => {
  try {
    const text = readFileSync(profilePatchPath, 'utf8');
    const m = text.match(/^\s*indexPath:\s*(.+?)\s*$/m);
    return m ? m[1].replace(/^["']|["']$/g, '') : undefined;
  } catch { return undefined; }
})();
if (!indexPath) {
  bad('profile patch 里读不到 indexPath —— 守卫会退回按文件名匹配（任何项目的 MEMORY.md 都会被拦）');
} else if (!existsSync(indexPath)) {
  bad(`indexPath 指向的文件不存在：${indexPath}`);
} else {
  const bytes = statSync(indexPath).size;
  const lines = readFileSync(indexPath, 'utf8').split('\n').length - 1;
  ok(`indexPath = ${indexPath}（${lines} 行 / ${bytes} 字节 ⇒ 守卫只保护这一个文件）`);
}

// ── 4. 我自己的插件还能不能被宿主正确加载 ─────────────────────────────────
console.log('\n4) 召回插件自检');
const recallPkg = join(PKG_DIR, 'package.json');
if (!existsSync(recallPkg)) {
  bad(`找不到召回插件包：${recallPkg}`);
} else {
  const linked = existsSync(join(profileDir, 'node_modules', 'dsh-engramory-recall'));
  linked
    ? ok('dsh-engramory-recall 已挂在 profile 的 node_modules 里')
    : bad('dsh-engramory-recall 不在 profile 的 node_modules 里（被卸载了？）');
  if (!skipTests) {
    const run = spawnSync(process.execPath, ['--test', 'test/recall.test.mjs'], { cwd: PKG_DIR, encoding: 'utf8' });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const pass = Number(out.match(/^# pass (\d+)$/m)?.[1] ?? out.match(/ℹ pass (\d+)/)?.[1] ?? -1);
    const fail = Number(out.match(/^# fail (\d+)$/m)?.[1] ?? out.match(/ℹ fail (\d+)/)?.[1] ?? -1);
    if (run.status === 0 && fail === 0) ok(`插件单测通过（${pass} 例）—— 宿主接口没变`);
    else bad(`插件单测未通过（pass=${pass} fail=${fail}）—— 宿主接口可能变了，看上面的输出`);
  } else {
    notes.push('本次跳过了插件单测（--skip-tests）');
  }
}

// ── 5. 活体守卫测试（必须由 agent 用 write 工具做）────────────────────────
console.log('\n5) 活体守卫测试（脚本做不了，必须让 agent 用 write 工具触发）');
console.log('   守卫只拦 write / edit / str_replace 这类工具调用；脚本直接写盘会绕过它。步骤：');
console.log('     a. 在工作区建一个 201 行的  MEMORY.md（例如 .engramory-guard-probe/MEMORY.md）');
console.log('     b. 让 agent 用 write 工具把它写成 202 行');
console.log('     c. 期望：**被放行**（说明守卫已钉在真库上、不再按文件名匹配）');
console.log('        —— 若被拒（报 “> 200 lines”），说明 indexPath 没生效；');
console.log('     d. 反过来把真库索引撑到 201 行再试写 202 行，期望**被拒**；测完记得恢复。');

// ── 结论 ──────────────────────────────────────────────────────────────────
if (notes.length) {
  console.log('\n备注');
  for (const note of notes) console.log(`  · ${note}`);
}
console.log(
  problems.length
    ? `\n结论：${problems.length} 项需要处理（见上面 ✗/⚠）。`
    : '\n结论：接线全部正常 —— 升级没有让配置静默失效。',
);
process.exit(problems.length ? 1 : 0);
