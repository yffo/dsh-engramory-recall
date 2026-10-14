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
import { readFileSync } from 'node:fs';

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
console.log(`  integrity   ${comparable ? (remoteIntegrity === packed.integrity ? '一致 ✓' : `不一致 ✖（远端 ${remoteIntegrity}）`) : remoteIntegrity}`);
console.log(`  tarball     ${last.dist?.tarball}`);

// dist-tags.latest 也顺带看一眼：发上去了但不是 latest，用户 npm i 拿到的还是旧版本
const packument = await (await fetch(`${registry}/${pkg.name}`)).json();
const latest = packument['dist-tags']?.latest;
console.log(`  dist-tags.latest = ${latest}${latest === version ? ' ✓' : ' ⚠️（不是这个版本）'}`);

if (!comparable) {
  console.log(`✓ ${version} 在 registry 上（历史版本，只核对存在性与 dist-tags）。`);
  process.exit(0);
}
if (remoteShasum !== packed.shasum || remoteIntegrity !== packed.integrity) {
  console.error('✖ 与工作区这一份对不上：registry 上的 tarball 不是这里打出来的（可能有人重发过同一个版本号）。');
  process.exit(1);
}
console.log('✓ 发上去的就是工作区这一份。');
