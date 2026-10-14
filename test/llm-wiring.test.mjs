/**
 * 接线测试：语义增强（llm.js）怎么挂进插件、以及**关着的时候它到底在不在**。
 *
 * 这一层测的不是 llm.js 自己的逻辑（那在 test/llm.test.mjs），而是招牌承诺的结构性保证：
 * 两个开关默认关着时，(1) 工具不注册、(2) 静态依赖图里没有 llm.js。
 * 前者靠假 ctx 数注册了几个工具，后者靠读 index.js 源码。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../index.js';

function fixtureStore() {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-llm-wiring-'));
  writeFileSync(join(dir, 'MEMORY.md'), '# Memory Index\n\n- [代理节点](reference-proxy.md) — Hy2 双端口\n');
  writeFileSync(
    join(dir, 'reference-proxy.md'),
    [
      '---',
      'name: reference-proxy',
      'description: 美国自建代理节点架构：Hy2 双端口主力 + Trojan 兜底',
      'type: reference',
      '---',
      '',
      '# 美国自建代理节点架构',
      '',
      'Hy2 双端口主力 + Trojan 兜底，旧 VMess/VLESS 已退役。',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'project-cicd.md'),
    ['---', 'name: project-cicd', 'description: Jenkins 流水线与站点部署', '---', '', '# CI/CD', '', 'Jenkins 多段部署命令只有第一条走 SSH。'].join('\n'),
  );
  return dir;
}

/** 假 LLM：按脚本吐 chunk，用来验证工具那条链真的把文本接回来了。 */
function fakeLlm(chunks) {
  return {
    calls: [],
    async *stream(options) {
      this.calls.push(options);
      for (const chunk of chunks) yield chunk;
    },
  };
}

function applyWith(config, llm) {
  const tools = new Map();
  const routes = [];
  const guards = [];
  const ctx = {
    on: () => {},
    get: (name) => (name === 'llm' ? llm : undefined),
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    tools: {
      register: (definition) => tools.set(definition.name, definition),
      guard: (fn) => { guards.push(fn); return () => {}; },
    },
    inject: (deps, fn) => {
      if (deps.includes('webServer')) fn({ webServer: { register: (route) => { routes.push(route); return () => {}; } } });
      if (deps.includes('skills')) fn({ effect: (f) => f(), skills: { register: () => () => {} } });
    },
  };
  apply(ctx, config);
  return { tools, routes, guards };
}

test('默认配置：只注册检索工具，语义工具一个都不存在', () => {
  const { tools } = applyWith({ storePath: fixtureStore() });
  assert.deepEqual([...tools.keys()], ['engramory_search']);
  assert.equal(tools.has('engramory_conflicts'), false);
  assert.equal(tools.has('engramory_summarize'), false);
});

test('静态依赖图：index.js 不 import llm.js（关着的时候这条路径不存在）', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const staticImports = [...source.matchAll(/^\s*import\s[^;]*from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.equal(staticImports.includes('./llm.js'), false, 'index.js 不许静态 import llm.js');
  // 唯一允许的引用方式是工具被调用那一刻的动态 import。
  assert.match(source, /await import\('\.\/llm\.js'\)/);
});

test('semanticConflicts 打开：注册 engramory_conflicts，并真的把模型的指认变成 findings', async () => {
  const storePath = fixtureStore();
  const llm = fakeLlm([
    { type: 'block-start', index: 0 },
    { type: 'text-delta', index: 0, text: '[{"files":["reference-proxy.md","project-cicd.md"],' },
    { type: 'text-delta', index: 0, text: '"reason":"两边对部署方式说法相反"},{"files":["编的.md","project-cicd.md"],"reason":"名字不存在"}]' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const { tools } = applyWith({ storePath, semanticConflicts: true }, llm);
  assert.equal(tools.has('engramory_conflicts'), true);

  const value = await tools.get('engramory_conflicts').execute({});
  assert.equal(value.store, storePath);
  assert.equal(value.notes, 2);
  const codes = value.findings.map((f) => f.code);
  assert.ok(codes.includes('semantic-conflict'), `应当有一条真冲突：${JSON.stringify(value.findings)}`);
  const conflict = value.findings.find((f) => f.code === 'semantic-conflict');
  assert.deepEqual(conflict.files, ['reference-proxy.md', 'project-cicd.md']);
  // 编出来的文件名必须被丢弃，并且如实报出「丢了几处」，不许拿它当结论。
  assert.equal(value.findings.some((f) => f.files.includes('编的.md')), false);
  assert.ok(value.findings.some((f) => f.code === 'semantic-unavailable' && f.message.includes('1 处')), '丢弃数要报出来');
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].model, 'deepseek-flash');
});

test('semanticConflicts 打开但宿主没有 LLM 服务：降级成一条 warn，不抛', async () => {
  const { tools } = applyWith({ storePath: fixtureStore(), semanticConflicts: true }, undefined);
  const value = await tools.get('engramory_conflicts').execute({});
  assert.equal(value.findings.length, 1);
  assert.equal(value.findings[0].severity, 'warn');
  assert.equal(value.findings[0].code, 'semantic-unavailable');
});

test('semanticSummary 打开：摘要取回文本；模型报错时把错误码带出来（不返回空摘要冒充成功）', async () => {
  const storePath = fixtureStore();
  const ok = fakeLlm([
    { type: 'text-delta', index: 0, text: '美国自建代理用 Hy2 双端口，Trojan 兜底。' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const { tools } = applyWith({ storePath, semanticSummary: true }, ok);
  assert.equal(tools.has('engramory_summarize'), true);

  const good = await tools.get('engramory_summarize').execute({ file: 'reference-proxy.md' });
  assert.equal(good.summary, '美国自建代理用 Hy2 双端口，Trojan 兜底。');
  assert.equal(good.model, 'deepseek-flash');
  assert.equal(good.error, undefined);

  const missing = await tools.get('engramory_summarize').execute({ file: 'nope.md' });
  assert.match(missing.error, /库里没有/);

  const broken = fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { code: 'MISSING_CREDENTIAL', message: '没配 key' } } }]);
  const { tools: brokenTools } = applyWith({ storePath, semanticSummary: true }, broken);
  const value = await brokenTools.get('engramory_summarize').execute({ file: 'reference-proxy.md' });
  assert.equal(value.summary, '');
  assert.match(value.error, /MISSING_CREDENTIAL/);
  assert.match(value.error, /llm-error/);
});

test('面板自报：两个开关的状态如实反映配置', () => {
  const off = applyWith({ storePath: fixtureStore() });
  const get = off.routes.find((route) => route.method === 'GET' || route.method === undefined);
  assert.ok(get, '应当注册了面板读路由');
  const response = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers ?? {}); },
    end(body) { this.body = body ?? ''; },
  };
  get.handler({ method: 'GET', headers: {}, url: '/api/engramory-recall' }, response);
  const payload = JSON.parse(response.body);
  assert.equal(payload.config.semanticConflicts, false);
  assert.equal(payload.config.semanticSummary, false);

  const on = applyWith({ storePath: fixtureStore(), semanticConflicts: true, semanticSummary: true });
  const onGet = on.routes.find((route) => route.method === 'GET' || route.method === undefined);
  const onResponse = { ...response, body: '' };
  onGet.handler({ method: 'GET', headers: {}, url: '/api/engramory-recall' }, onResponse);
  const onPayload = JSON.parse(onResponse.body);
  assert.equal(onPayload.config.semanticConflicts, true);
  assert.equal(onPayload.config.semanticSummary, true);
});
