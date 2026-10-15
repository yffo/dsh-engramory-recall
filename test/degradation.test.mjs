/**
 * 「依赖崩了，这一轮也不能崩」——降级路径的回归。
 *
 * 为什么这么测：`index.js` 里有一串 `try { … } catch { … }`，注释都写着「绝不影响这一轮」，
 * 但**在这份文件之前没有一个用例真的让依赖抛过异常** —— 这些 catch 全是靠代码审阅相信的。
 * ESM 的具名导入没法在进程里替换，所以这里把整包**复制到临时目录**、把某一个依赖模块
 * 换成会抛异常的桩，再 import 那份副本（模块缓存按 URL 走，所以每个用例一份副本）。
 *
 * 钉住的行为：
 *   1. 归档模块抛异常 → 状态路由照常 200，`archive.crashed` 带原话；
 *   2. 体检模块抛异常 → 只是 `audit-crashed` 一条 error，其余字段照常；
 *   3. POST /archive 重算计划抛异常 → 500「重算计划失败」，不是崩连接；
 *   4. POST /archive 执行归档抛异常 → 400「归档抛异常」，不是 500；
 *   5. 检索抛异常 → 这一轮原样放行（一个 token 都不注入），也不写注入行；
 *   6. 自动归档抛异常 → 账上留一行 `archive-auto`，召回照常。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { USAGE_FILE } from '../usage.js';

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** 整包复制到临时目录（排除测试/基准/依赖），再按需把某个依赖换成桩。 */
function makeRepo(stub) {
  const home = mkdtempSync(join(tmpdir(), 'engramory-degrade-'));
  const repo = join(home, 'repo');
  cpSync(PKG_DIR, repo, {
    recursive: true,
    filter: (src) => !/\/(\.git|node_modules|test|bench|\.tmp)(\/|$)/.test(src),
  });
  if (stub) writeFileSync(join(repo, stub.file), stub.source);

  const store = join(home, 'store');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'MEMORY.md'), '# 索引\n\n- reference-x.md — 代理节点双端口\n');
  writeFileSync(
    join(store, 'reference-x.md'),
    ['---', 'name: reference-x', 'description: 美国自建代理节点：Hy2 双端口 + Trojan 兜底', '---', '', '# 代理节点', '', 'Hy2 双端口主力，Trojan 兜底。'].join('\n'),
  );
  return { home, repo, store, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const loadPlugin = (repo) => import(pathToFileURL(join(repo, 'index.js')).href);

/** 假宿主：收集 pre-step 钩子与所有 HTTP 路由。 */
function boot(mod, config) {
  let handler = null;
  const routes = [];
  const ctx = {
    on: (event, fn) => { if (event === 'agent/pre-step') handler = fn; },
    tools: { register: () => {}, guard: () => () => {} },
    inject: (deps, fn) => {
      if (deps.includes('webServer')) {
        fn({ webServer: { register: (route) => { routes.push(route); return () => {}; } } });
      }
    },
  };
  mod.apply(ctx, config);
  assert.ok(handler, 'apply() 应当注册 agent/pre-step 监听');
  return { handler, routes };
}

function captureResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers ?? {}); },
    end(body) { this.body = body ?? ''; },
  };
}

function fakeReq({ method = 'POST', body = '' } = {}) {
  const handlers = {};
  return {
    method,
    on(event, fn) { (handlers[event] ??= []).push(fn); return this; },
    destroy() {},
    /** 把请求体喂给 readBody 的监听器（handler 里 readBody 是同步注册的）。 */
    fire() {
      for (const fn of handlers.data ?? []) fn(Buffer.from(body));
      for (const fn of handlers.end ?? []) fn();
    },
  };
}

const routeOf = (routes, path) => routes.find((r) => r.path === path);
const usageRows = (store) => {
  const file = join(store, USAGE_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

const realUrl = (name) => JSON.stringify(pathToFileURL(join(PKG_DIR, name)).href);

const ARCHIVE_THROWS = {
  file: 'archive.js',
  source: [
    '// 桩：归档模块整个坏掉，用来验证调用方有没有兜住（其余导出原样转出去，别的模块还要用）。',
    `export * from ${realUrl('archive.js')};`,
    "export function planArchive() { throw new Error('归档模块炸了'); }",
    "export function applyArchive() { throw new Error('归档模块炸了'); }",
    '',
  ].join('\n'),
};

const ARCHIVE_APPLY_THROWS = {
  file: 'archive.js',
  source: [
    '// 桩：计划算得出来，但一动手就炸。',
    `export * from ${realUrl('archive.js')};`,
    "export function planArchive() { return { plans: [{ file: 'reference-x.md', bytes: 2048, keptBytes: 1024, batches: 2, moveBytes: 1024, historyFiles: [] }], skipped: [] }; }",
    "export function applyArchive() { throw new Error('搬不动模块炸了'); }",
    '',
  ].join('\n'),
};

const DOCTOR_THROWS = {
  file: 'doctor.js',
  source: [
    '// 桩：体检模块整个坏掉。',
    `export * from ${realUrl('doctor.js')};`,
    "export function auditStore() { throw new Error('体检模块炸了'); }",
    '',
  ].join('\n'),
};

const SEARCH_THROWS = {
  file: 'bm25.js',
  source: [
    '// 桩：检索整个坏掉，其余（建索引/分词/截断）还是真的。',
    `export * from ${realUrl('bm25.js')};`,
    "export function search() { throw new Error('检索模块炸了'); }",
    '',
  ].join('\n'),
};

test('状态路由：归档模块抛异常时给 crashed，路由本身照常 200', async () => {
  const fx = makeRepo(ARCHIVE_THROWS);
  try {
    const { routes } = boot(await loadPlugin(fx.repo), { storePath: fx.store });
    const route = routeOf(routes, '/api/engramory-recall/state');
    assert.ok(route, '状态路由要注册上');
    const res = captureResponse();
    await route.handler({ method: 'GET' }, res);
    assert.equal(res.status, 200, '归档崩了不该让面板整页拿不到状态');
    const body = JSON.parse(res.body);
    assert.match(body.archive.crashed, /归档模块炸了/, '原话要带回来，别吞成「未知错误」');
    assert.deepEqual(body.archive.plans, []);
  } finally {
    fx.cleanup();
  }
});

test('状态路由：体检模块抛异常时只是一条 audit-crashed，其余字段照常', async () => {
  const fx = makeRepo(DOCTOR_THROWS);
  try {
    const { routes } = boot(await loadPlugin(fx.repo), { storePath: fx.store });
    const res = captureResponse();
    await routeOf(routes, '/api/engramory-recall/state').handler({ method: 'GET' }, res);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    const crashed = body.audit.findings.find((f) => f.code === 'audit-crashed');
    assert.ok(crashed, '体检崩了要变成一条 error，而不是让 /state 500');
    assert.equal(crashed.severity, 'error');
    assert.match(crashed.message, /体检模块炸了/);
    assert.equal(body.audit.summary.bySeverity.error, 1);
    assert.equal(body.writeAudit.epoch.length > 0, true, '别的字段不受影响');
  } finally {
    fx.cleanup();
  }
});

test('POST /archive：重算计划抛异常 → 500「重算计划失败」，不是崩连接', async () => {
  const fx = makeRepo(ARCHIVE_THROWS);
  try {
    const { routes } = boot(await loadPlugin(fx.repo), { storePath: fx.store });
    const req = fakeReq({ body: JSON.stringify({ confirm: true, file: 'reference-x.md' }) });
    const res = captureResponse();
    const pending = routeOf(routes, '/api/engramory-recall/archive').handler(req, res);
    req.fire();
    await pending;
    assert.equal(res.status, 500);
    assert.match(JSON.parse(res.body).reason, /重算计划失败：归档模块炸了/);
  } finally {
    fx.cleanup();
  }
});

test('POST /archive：执行归档抛异常 → 400「归档抛异常」，并且照样留审计', async () => {
  const fx = makeRepo(ARCHIVE_APPLY_THROWS);
  try {
    const { routes } = boot(await loadPlugin(fx.repo), { storePath: fx.store });
    const req = fakeReq({ body: JSON.stringify({ confirm: true, file: 'reference-x.md' }) });
    const res = captureResponse();
    const pending = routeOf(routes, '/api/engramory-recall/archive').handler(req, res);
    req.fire();
    await pending;
    assert.equal(res.status, 400, '归档失败是「这次没成」，不是「服务器炸了」');
    const body = JSON.parse(res.body);
    assert.match(body.reason, /归档抛异常：搬不动模块炸了/);
    assert.equal(body.file, 'reference-x.md');
    // 失败也要留痕：审计要能回答「谁把它改成这样的」
    const audit = readFileSync(join(fx.store, '.engramory-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(audit.at(-1).tool, 'archive');
    assert.equal(audit.at(-1).verdict, 'deny');
    assert.match(audit.at(-1).reason, /搬不动模块炸了/);
  } finally {
    fx.cleanup();
  }
});

test('pre-step：检索抛异常时这一轮原样放行，一个 token 都不注入', async () => {
  const fx = makeRepo(SEARCH_THROWS);
  try {
    const { handler } = boot(await loadPlugin(fx.repo), { storePath: fx.store });
    const decision = { kind: 'enter', messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '代理节点的双端口是怎么配的' }], source: { kind: 'user' } }] };
    const out = await handler({}, async () => decision);
    assert.equal(out, decision, '召回失败必须原样放行（返回同一个 decision，不是 undefined）');
    assert.equal(out.messages.length, 1, '不许在半路塞进半截注入');
    assert.equal(usageRows(fx.store).some((r) => r.kind === 'hit'), false, '没注入成功就不该写 hit 行');
  } finally {
    fx.cleanup();
  }
});

test('pre-step：自动归档抛异常时只在账上留一行 archive-auto，召回照常', async () => {
  const fx = makeRepo(ARCHIVE_THROWS);
  try {
    const { handler } = boot(await loadPlugin(fx.repo), { storePath: fx.store, autoArchive: true });
    const decision = { kind: 'enter', messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '代理节点的双端口是怎么配的' }], source: { kind: 'user' } }] };
    const out = await handler({}, async () => decision);
    assert.equal(out.messages.length, 2, '自动归档崩了不影响这一轮照常注入（注入那一条照旧追加）');
    const row = usageRows(fx.store).find((r) => r.kind === 'archive-auto');
    assert.ok(row, '自动归档崩了要在账上留痕');
    assert.match(row.reason, /自动归档异常：归档模块炸了/);
    assert.equal(row.query.length > 0, true, '要记下是谁触发的');
  } finally {
    fx.cleanup();
  }
});
