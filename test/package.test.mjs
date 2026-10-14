// 打包自检：`files` 是白名单，漏一个模块就是「别人装上直接崩」。
//
// 这个错犯过两次：先是 audit.js（index.js 顶层 import 它），再是 archive.js。
// 两次都是手写 npm pack --dry-run 才发现的 —— 本机跑得好好的，因为本机读的是源码目录，
// 白名单只在发布时起作用。所以把它写成测试：谁再新增一个被 import 的模块而忘了加白名单，
// `npm test` 当场就红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

/** 从入口出发，递归收集所有被 import 的本仓相对模块（只跟 `./` 开头、`.js` 结尾的）。 */
function collectLocalModules(entry) {
  const seen = new Set();
  const walk = (file) => {
    const abs = resolve(root, file);
    if (seen.has(abs) || !existsSync(abs)) return;
    seen.add(abs);
    const src = readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      walk(relative(root, resolve(dirname(abs), m[1])));
    }
  };
  walk(entry);
  return [...seen].map((abs) => relative(root, abs));
}

test('打包：入口递归 import 到的每个模块都在 files 白名单里', () => {
  // 入口是别人真正会加载的那些：包根（index.js）与客户端 bundle。
  const entries = [pkg.exports['.'], pkg.exports['./client']].filter(Boolean);
  assert.ok(entries.length, 'exports 里该有 "." 与 "./client"');

  const shipped = new Set(pkg.files);
  const missing = [];
  for (const entry of entries) {
    for (const mod of collectLocalModules(entry)) {
      if (!shipped.has(mod)) missing.push(mod);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `这些模块被 import 但不在 files 白名单里，发布后加载即 ERR_MODULE_NOT_FOUND：${missing.join(', ')}`,
  );
});

test('打包：exports 映射指向的文件真实存在', () => {
  for (const [key, target] of Object.entries(pkg.exports)) {
    assert.ok(existsSync(resolve(root, target)), `exports["${key}"] → ${target} 不存在`);
  }
});

test('打包：cordis.patch.yml 在包里（宿主靠它把插件挂上）', () => {
  const patch = pkg.dsh?.bundle?.patch;
  assert.ok(patch, 'package.json 该声明 dsh.bundle.patch');
  assert.ok(pkg.files.includes(patch.replace(/^\.\//, '')), `${patch} 必须在 files 白名单里`);
});
