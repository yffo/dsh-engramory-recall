#!/usr/bin/env node
/**
 * 发布之后的「真的上去了吗」校验 —— 不靠 `npm publish` 的退出码，也不靠眼睛看。
 *
 * 为什么要单独一个脚本：
 *   1. `npm publish` 的退出码在网络上抖动时会骗人；「已发布」的唯一硬证据是 registry 直查；
 *   2. registry 的 **packument 有分钟级缓存**（`npm view <pkg> versions` 可能还没看到新版本），
 *      所以要轮询**版本端点** `/<pkg>/<version>`，不能只信 packument；
 *   3. 还要证明「发上去的那一份 = 工作区这一份」：本地 `npm pack` 的 shasum 必须与
 *      registry 上的 `dist.shasum` 逐字一致 —— 比版本号存在强得多的证据。
 *
 * 用法：
 *   node scripts/verify-release.mjs                # 校验 package.json 里的版本
 *   node scripts/verify-release.mjs 0.9.0          # 校验指定版本
 *   node scripts/verify-release.mjs --timeout 300  # 最多等 300 秒（默认 180）
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

const args = process.argv.slice(2);
const timeoutArg = args.indexOf('--timeout');
const timeoutMs = (timeoutArg >= 0 ? Number(args[timeoutArg + 1]) : 180) * 1000;
const wanted = args.find((a) => /^\d+\.\d+\.\d+/.test(a));

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version = wanted ?? pkg.version;
const registry = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org';

// 本地打一份（不落盘）：拿到 shasum / integrity / 文件数，作为比对基准
const packed = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
)[0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
let last = null;

for (;;) {
  const response = await fetch(`${registry}/${pkg.name}/${version}`, { headers: { accept: 'application/json' } });
  if (response.ok) {
    last = await response.json();
    break;
  }
  last = { status: response.status };
  if (Date.now() - started > timeoutMs) {
    console.error(`✖ 等了 ${(timeoutMs / 1000) | 0} 秒，${registry}/${pkg.name}/${version} 还是 ${response.status} —— 没发上去。`);
    process.exit(1);
  }
  await sleep(5000);
}

const remoteShasum = last.dist?.shasum;
const remoteIntegrity = last.dist?.integrity;
// 只有「当前工作区版本 == 被校验的版本」时，本地 pack 才能当基准 ——
// 否则拿 0.9.0 的树去校验 0.8.1，shasum 必然不同，那是脚本用错了，不是发布错了。
const comparable = version === pkg.version;

console.log(`包：${pkg.name}@${version}（等了 ${((Date.now() - started) / 1000).toFixed(0)} 秒）`);
console.log(`  本地 pack   shasum=${packed.shasum}  文件数=${packed.entryCount}${comparable ? '' : `（工作区在 ${pkg.version}，不参与比对）`}`);
console.log(`  registry    shasum=${remoteShasum}  文件数=${last.dist?.fileCount ?? '（未提供）'}`);
console.log(`  integrity   ${remoteIntegrity}`);
console.log(`  tarball     ${last.dist?.tarball}`);

// dist-tags.latest 也顺带看一眼：发上去了但不是 latest，用户 npm i 拿到的还是旧版本。
// 但 packument 有 CDN 缓存：实测刚发完 100 秒读到的还是旧值，而版本端点早就是新的（0.9.0 那次
// CI 就报了假警报）。所以这里给最多 60 秒宽限，超时再提醒，不把缓存滞后报成「发错版本」。
let latest;
for (let waited = 0; ; waited += 10) {
  latest = (await (await fetch(`${registry}/${pkg.name}`)).json())['dist-tags']?.latest;
  if (latest === version || waited >= 60) break;
  await new Promise((r) => setTimeout(r, 10_000));
}
console.log(
  `  dist-tags.latest = ${latest}${latest === version ? ' ✓' : ' ⚠️（还不是这个版本；packument 有 CDN 缓存，过一两分钟再 npm view 看一眼）'}`,
);

if (!comparable) {
  console.log(`✓ ${version} 在 registry 上（历史版本，只核对存在性与 dist-tags）。`);
  process.exit(0);
}
// shasum/integrity 只在「两端 npm 版本与压缩设置相同」时才相等。
// 实测踩过：CI（npm 11.21.0）打的 tarball 与本地（npm 11.11.0）打的内容一模一样、字节不同，
// 于是本地跑这个脚本会报「有人重发过同一个版本号」的假警报。所以不一致时退一步做**内容级**比对。
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 解开一个 .tgz，返回 { 相对路径 -> 内容 sha256 } */
function digestOfTarball(tarballPath, dir) {
  execFileSync('tar', ['-xzf', tarballPath, '-C', dir]);
  const root = join(dir, 'package');
  const out = new Map();
  (function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(relative(root, full).split(sep).join('/'), sha256(readFileSync(full)));
    }
  })(root);
  return out;
}

/** 本地这一份的内容：优先用 npm pack --json 的文件清单，缺清单就真打一份再解 */
function digestOfWorkspace() {
  const fromList = packed.files;
  const out = new Map();
  if (Array.isArray(fromList) && fromList.length > 0) {
    for (const f of fromList) out.set(f.path, sha256(readFileSync(new URL(`../${f.path}`, import.meta.url))));
    return out;
  }
  const dir = mkdtempSync(join(tmpdir(), 'verify-release-'));
  try {
    const name = execFileSync('npm', ['pack', '--json'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const tgz = JSON.parse(name)[0].filename;
    const abs = join(new URL('..', import.meta.url).pathname, tgz);
    try {
      return digestOfTarball(abs, dir);
    } finally {
      rmSync(abs, { force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function compareContent() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-release-'));
  try {
    const tgz = join(dir, 'remote.tgz');
    writeFileSync(tgz, Buffer.from(await (await fetch(last.dist.tarball)).arrayBuffer()));
    const remote = digestOfTarball(tgz, dir);
    const local = digestOfWorkspace();
    const diffs = [];
    for (const [path, hash] of local) if (remote.get(path) !== hash) diffs.push(path + (remote.has(path) ? '（内容不同）' : '（远端没有）'));
    for (const path of remote.keys()) if (!local.has(path)) diffs.push(path + '（本地没有）');
    return diffs;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (remoteShasum === packed.shasum && remoteIntegrity === packed.integrity) {
  console.log('✓ 发上去的就是工作区这一份（shasum 逐字一致）。');
  process.exit(0);
}

console.log('  shasum 与本地 pack 不同 —— 退一步比内容（两端 npm 版本不同时，tarball 字节会不同）');
const diffs = await compareContent();
if (diffs.length > 0) {
  console.error(`✖ 与工作区这一份对不上：${diffs.length} 个文件有差异 —— ${diffs.slice(0, 8).join('、')}`);
  console.error('  这可能是有人重发过同一个版本号；本地 npm 版本不同不会造成内容差异。');
  process.exit(1);
}
console.log(`✓ 内容逐字节一致（${packed.entryCount} 个文件全等）—— tarball 字节不同只是两端 npm 版本/压缩设置不同。`);
