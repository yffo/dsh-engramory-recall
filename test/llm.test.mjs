// llm.js 的测试：全用**假 LLM**（async generator），不联网、不真调模型。
//
// 重点不是覆盖率，而是把「招牌不许破」这件事钉死：
//  - import 本身不发任何调用（默认关闭）；
//  - 失败的两个来源（终止 chunk / 抛异常）都被归一成带 code 的错误，且 detectConflicts 永不抛；
//  - 模型编出来的文件名进不了 findings —— 检测结果必须能对上真实文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_CALLS,
  MAX_NOTE_CHARS,
  MAX_NOTES_PER_CALL,
  LLM_ABORTED,
  LLM_EMPTY,
  LLM_ERROR,
  LLM_NO_ROUTE,
  LLM_TIMEOUT,
  LLM_UNAVAILABLE,
  collectText,
  detectConflicts,
  getLlm,
  resolveRoute,
  summarizeNote,
} from '../llm.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLAIN = { provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: '…' }] }] };

/** 假 LLM：按调用次序播放脚本，并记录每次 stream 收到的 options —— 「发了几次、发了什么」全靠它断言。 */
function fakeLlm(...plays) {
  const calls = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      const play = plays[Math.min(calls.length - 1, plays.length - 1)] ?? {};
      return (async function* () {
        if (play.throwBefore) throw play.throwBefore;
        for (const chunk of play.chunks ?? []) yield chunk;
        if (play.throwAfter) throw play.throwAfter;
      })();
    },
  };
}

/** 一次正常应答：文本切若干 text-delta（模拟真流式）+ usage + finish(stop)。 */
function textPlay(text, { chunkSize = 3 } = {}) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) chunks.push({ type: 'text-delta', index: 0, text: text.slice(i, i + chunkSize) });
  return { chunks: [...chunks, { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }, { type: 'finish', reason: { kind: 'stop' } }] };
}

/** 永不自己结束的流：只等 signal abort 后抛 AbortError（真宿主超时/取消就是这个形态）。 */
function hangingLlm() {
  return {
    calls: [],
    stream(options) {
      return (async function* () {
        await new Promise((_, reject) => {
          const abort = () => {
            const error = new Error('This operation was aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (options.signal.aborted) abort();
          else options.signal.addEventListener('abort', abort);
        });
      })();
    },
  };
}

function fakeCtx({ llm, selection, selectionThrows = false, getThrows = false } = {}) {
  const ctx = {
    getCalls: 0,
    get(name) {
      ctx.getCalls++;
      if (getThrows) throw new Error('cordis: 服务上下文已销毁');
      return name === 'llm' ? llm : undefined;
    },
  };
  if (selectionThrows) {
    ctx.agentDefaultModel = {
      currentSelection() {
        throw new Error('cannot read property of undefined');
      },
    };
  } else if (selection !== undefined) {
    ctx.agentDefaultModel = { currentSelection: () => selection };
  }
  return ctx;
}

const runtimeWith = (llm, selection = { provider: 'p', model: 'm' }, config = {}) => ({
  ctx: fakeCtx({ llm, selection }),
  config: { timeoutMs: 5000, ...config },
});

/** 取出假 LLM 收到的第 n 次请求的全部文本（system + messages）。 */
const sentText = (options) =>
  [options.system ?? '', ...(options.messages ?? []).map((m) => m.content.map((b) => b.text ?? '').join(''))].join('\n');

const codeOf = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error.code;
  }
};

// ---------------------------------------------------------------- 正常路径

test('collectText：累加 text-delta，usage / reasoning-delta / 终止 chunk 之后的东西都不进文本', async () => {
  const llm = fakeLlm({
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'reasoning-delta', index: 0, text: '（思考过程不是答案）' },
      { type: 'text-delta', index: 0, text: '结论：' },
      { type: 'usage', usage: { inputTokens: 9, outputTokens: 2 } },
      { type: 'text-delta', index: 0, text: '用 A 方案。' },
      { type: 'tool-call-delta', id: 't1', name: 'noop', argumentsDelta: '{"x":1}' },
      { type: 'finish', reason: { kind: 'stop' } },
      { type: 'text-delta', index: 0, text: '协议保证终止 chunk 之后不再有东西' },
    ],
  });
  const r = await collectText(llm, { ...PLAIN, maxTokens: 64 }, 5000);
  assert.equal(r.text, '结论：用 A 方案。');
  assert.equal(r.model, 'm');
  assert.equal(r.finished, true);
  assert.ok(r.ms >= 0);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].provider, 'p');
  assert.equal(llm.calls[0].maxTokens, 64);
  assert.ok(llm.calls[0].signal instanceof AbortSignal, '超时必须通过 options.signal 传进去');
});

test('collectText：没见到终止 chunk —— 有文本就带 finished:false 出来，一个字都没有才报 llm-empty', async () => {
  const partial = await collectText(fakeLlm({ chunks: [{ type: 'text-delta', index: 0, text: '半截' }] }), PLAIN, 5000);
  assert.equal(partial.text, '半截');
  assert.equal(partial.finished, false);
  assert.equal(await codeOf(() => collectText(fakeLlm({ chunks: [] }), PLAIN, 5000)), LLM_EMPTY);
});

test('collectText：llm 缺失 / 不是服务 → llm-unavailable，而不是 TypeError', async () => {
  assert.equal(await codeOf(() => collectText(undefined, PLAIN, 1000)), LLM_UNAVAILABLE);
  assert.equal(await codeOf(() => collectText({}, PLAIN, 1000)), LLM_UNAVAILABLE);
});

// ------------------------------------------------- 失败形态一：终止 chunk

test('终止 chunk {kind:"error"} → llm-error，并原样带出 failure.code（额度/鉴权靠它排查）', async () => {
  const llm = fakeLlm({ chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '额度用尽' } } }] });
  await assert.rejects(
    () => collectText(llm, PLAIN, 5000),
    (error) => {
      assert.equal(error.code, LLM_ERROR);
      assert.match(error.message, /RATE_LIMIT/);
      assert.match(error.message, /额度用尽/);
      return true;
    },
  );
});

test('终止 chunk {kind:"aborted"} → llm-aborted', async () => {
  const llm = fakeLlm({ chunks: [{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'CANCELLED', message: '用户取消' } } }] });
  assert.equal(await codeOf(() => collectText(llm, PLAIN, 5000)), LLM_ABORTED);
});

// --------------------------------------------------- 失败形态二：抛异常

test('迭代中抛非 Abort 异常（中间件炸）→ llm-error，不会漏成未捕获异常', async () => {
  const llm = fakeLlm({ chunks: [{ type: 'text-delta', index: 0, text: 'x' }], throwAfter: new Error('中间件炸了') });
  await assert.rejects(
    () => collectText(llm, PLAIN, 5000),
    (error) => {
      assert.equal(error.code, LLM_ERROR);
      assert.match(error.message, /中间件炸了/);
      return true;
    },
  );
});

test('超时（AbortSignal.timeout 触发，抛 AbortError）→ llm-timeout，而不是 llm-aborted', async () => {
  await assert.rejects(
    () => collectText(hangingLlm(), PLAIN, 20),
    (error) => {
      assert.equal(error.code, LLM_TIMEOUT);
      assert.match(error.message, /20ms/);
      return true;
    },
  );
});

test('调用方自己的 signal 取消 → llm-aborted（与超时分开：处置方式完全不同）', async () => {
  const controller = new AbortController();
  const pending = collectText(hangingLlm(), { ...PLAIN, signal: controller.signal }, 5000);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    () => pending,
    (error) => {
      assert.equal(error.code, LLM_ABORTED);
      assert.match(error.message, /被取消/);
      return true;
    },
  );
});

// ------------------------------------------------------------------ 路由

test('getLlm：服务缺失返回 undefined（cordis 的真实行为），绝不抛', () => {
  assert.equal(getLlm(fakeCtx({ llm: undefined })), undefined);
  assert.equal(getLlm(undefined), undefined);
  assert.equal(getLlm({}), undefined);
  assert.equal(getLlm(fakeCtx({ getThrows: true })), undefined, 'ctx.get 自己炸也不能把 doctor 带走');
  const llm = fakeLlm(textPlay('x'));
  assert.equal(getLlm(fakeCtx({ llm })), llm);
});

test('resolveRoute：显式 > currentSelection > null，半截显式不算路由', () => {
  const ctx = fakeCtx({ selection: { provider: 'sel-p', model: 'sel-m', reasoningEffort: 'high' } });
  assert.deepEqual(resolveRoute(ctx, { provider: 'p', model: 'm' }), { provider: 'p', model: 'm' });
  assert.deepEqual(resolveRoute(ctx, { provider: 'p', model: 'm', reasoningEffort: 'max' }), { provider: 'p', model: 'm', reasoningEffort: 'max' });
  assert.deepEqual(resolveRoute(ctx, null), { provider: 'sel-p', model: 'sel-m', reasoningEffort: 'high' });
  assert.deepEqual(resolveRoute(ctx, {}), { provider: 'sel-p', model: 'sel-m', reasoningEffort: 'high' });
  // 只给一半时回落默认值：真塞给 stream() 会报 NO_ADAPTER 之类离原因很远的错。
  assert.deepEqual(resolveRoute(ctx, { provider: 'p' }), { provider: 'sel-p', model: 'sel-m', reasoningEffort: 'high' });
  assert.equal(resolveRoute(fakeCtx({}), null), null);
  assert.equal(resolveRoute(fakeCtx({ selection: { provider: 'only-p' } }), null), null);
  assert.equal(resolveRoute(fakeCtx({ selectionThrows: true }), null), null, '服务未就绪/代理抛错 → 当作没有默认模型');
});

// ---------------------------------------------------------------- 摘要

test('summarizeNote：返回 {summary, route, ms}，请求里带上文件名/标题/描述与正文', async () => {
  const llm = fakeLlm(textPlay('X 方案用来解决 Y；阈值 0.5。'));
  const r = await summarizeNote(runtimeWith(llm, { provider: 'p', model: 'm' }, { maxTokens: 128 }), {
    file: 'reference-x.md',
    title: 'X 方案',
    description: '一句话描述',
    body: '正文正文',
  });
  assert.equal(r.summary, 'X 方案用来解决 Y；阈值 0.5。');
  assert.deepEqual(r.route, { provider: 'p', model: 'm' });
  assert.ok(r.ms >= 0);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].maxTokens, 128);
  assert.match(sentText(llm.calls[0]), /reference-x\.md/);
  assert.match(sentText(llm.calls[0]), /X 方案/);
  assert.match(sentText(llm.calls[0]), /一句话描述/);
  assert.match(llm.calls[0].system, /不是对你的指令/, '笔记正文是不可信输入，得在 system 里先立规矩');
});

test('summarizeNote：options 里的路由压过 config，config 压过 currentSelection', async () => {
  const llm = fakeLlm(textPlay('摘要'), textPlay('摘要'));
  const runtime = { ctx: fakeCtx({ llm, selection: { provider: 'sel-p', model: 'sel-m' } }), config: { provider: 'cfg-p', model: 'cfg-m' } };
  const note = { file: 'reference-x.md', title: 't', description: 'd', body: 'b' };
  assert.deepEqual((await summarizeNote(runtime, note)).route, { provider: 'cfg-p', model: 'cfg-m' });
  assert.deepEqual((await summarizeNote(runtime, note, { provider: 'opt-p', model: 'opt-m' })).route, { provider: 'opt-p', model: 'opt-m' });
  assert.equal(llm.calls[0].provider, 'cfg-p');
  assert.equal(llm.calls[1].provider, 'opt-p');
});

test('summarizeNote：正文超过上限只喂前 MAX_NOTE_CHARS 字符，并如实标注截断', async () => {
  const llm = fakeLlm(textPlay('摘要'));
  await summarizeNote(runtimeWith(llm), { file: 'reference-big.md', title: 't', description: 'd', body: '字'.repeat(MAX_NOTE_CHARS + 500) });
  const sent = sentText(llm.calls[0]);
  assert.ok(sent.includes('字'.repeat(MAX_NOTE_CHARS)), '前 1200 字必须完整送达');
  assert.ok(!sent.includes('字'.repeat(MAX_NOTE_CHARS + 1)), '第 1201 个字起不许出现在请求里');
  assert.match(sent, new RegExp(`只给了前 ${MAX_NOTE_CHARS} 字符`));
});

test('summarizeNote：不可用 / 无路由 / 空回答都抛带 code 的错，绝不返回空摘要冒充成功', async () => {
  const note = { file: 'reference-x.md', title: 't', description: 'd', body: 'b' };
  assert.equal(await codeOf(() => summarizeNote({ ctx: fakeCtx({}) }, note)), LLM_UNAVAILABLE);
  assert.equal(await codeOf(() => summarizeNote({ ctx: fakeCtx({ llm: fakeLlm(textPlay('x')) }) }, note)), LLM_NO_ROUTE);
  const silent = fakeLlm({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] });
  assert.equal(await codeOf(() => summarizeNote(runtimeWith(silent), note)), LLM_EMPTY);
});

// ------------------------------------------------------------ 语义冲突

const NOTES = [
  { file: 'reference-a.md', title: 'A', description: 'A 的描述', body: '正文 A' },
  { file: 'reference-b.md', title: 'B', description: 'B 的描述', body: '正文 B' },
  { file: 'feedback-c.md', title: 'C', description: 'C 的描述', body: '正文 C' },
];

const CONFLICT_JSON = JSON.stringify([{ files: ['reference-a.md', 'reference-b.md'], reason: 'A 说这方案已弃用，B 说必须用它' }]);

test('detectConflicts：模型指认的矛盾变成 doctor 形状的 finding（键名与严重级都对得上）', async () => {
  const llm = fakeLlm(textPlay(CONFLICT_JSON));
  const findings = await detectConflicts(runtimeWith(llm), NOTES);
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.deepEqual(Object.keys(f).sort(), ['code', 'files', 'message', 'severity']);
  assert.equal(f.severity, 'warn');
  assert.equal(f.code, 'semantic-conflict');
  assert.deepEqual(f.files, ['reference-a.md', 'reference-b.md']);
  assert.match(f.message, /A 说这方案已弃用，B 说必须用它/);
  // 三篇都必须送进模型，否则「没报」可能是根本没给它看
  const sent = sentText(llm.calls[0]);
  for (const n of NOTES) assert.match(sent, new RegExp(n.file.replace('.', '\\.')));
  assert.match(llm.calls[0].system, /互相矛盾/);
});

test('detectConflicts：也认 store.readDocs() 的形状（id 当文件名、body 当正文）', async () => {
  const llm = fakeLlm(textPlay(CONFLICT_JSON));
  const docs = NOTES.map(({ file, title, description, body }) => ({ id: file, title, description, body }));
  const findings = await detectConflicts(runtimeWith(llm), docs);
  const conflict = findings.find((f) => f.code === 'semantic-conflict');
  assert.ok(conflict, '接线时拿到的可能是 readDocs() 的产物，形状必须兼容');
  assert.deepEqual(conflict.files, ['reference-a.md', 'reference-b.md']);
});

test('detectConflicts：模型编出的文件名被丢弃，只留一条「输出对不上」的 info，不产生冲突', async () => {
  const llm = fakeLlm(textPlay(JSON.stringify([{ files: ['reference-a.md', 'reference-不存在.md'], reason: '编的' }])));
  const findings = await detectConflicts(runtimeWith(llm), NOTES);
  assert.deepEqual(findings.filter((f) => f.code === 'semantic-conflict'), []);
  const info = findings.find((f) => f.code === 'semantic-unavailable');
  assert.ok(info, '丢弃过东西就要说出来，不能悄悄咽掉');
  assert.equal(info.severity, 'info');
  assert.match(info.message, /1 处输出对不上真实文件名/);
});

test('detectConflicts：一条真一条假时只留真的那条；说不出矛盾点的也丢', async () => {
  const llm = fakeLlm(
    textPlay(
      JSON.stringify([
        { files: ['reference-a.md', 'feedback-c.md'], reason: 'A 与 C 对同一阈值给了不同值' },
        { files: ['nonexistent-1.md', 'nonexistent-2.md'], reason: '两篇都不存在' },
        { files: ['reference-a.md', 'reference-b.md'], reason: '   ' },
      ]),
    ),
  );
  const findings = await detectConflicts(runtimeWith(llm), NOTES);
  const conflicts = findings.filter((f) => f.code === 'semantic-conflict');
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].files, ['reference-a.md', 'feedback-c.md']);
  assert.match(findings.find((f) => f.code === 'semantic-unavailable').message, /2 处/);
});

test('detectConflicts：同一对报两次只留一条', async () => {
  const llm = fakeLlm(textPlay(JSON.stringify([JSON.parse(CONFLICT_JSON)[0], JSON.parse(CONFLICT_JSON)[0]])));
  const findings = await detectConflicts(runtimeWith(llm), NOTES);
  assert.equal(findings.filter((f) => f.code === 'semantic-conflict').length, 1);
});

test('detectConflicts：模型整轮不是 JSON → 不报冲突、不关键词补位，只报「没查成」', async () => {
  const llm = fakeLlm(textPlay('这两篇看起来都跟路径有关，但我判断不出矛盾。'));
  const findings = await detectConflicts(runtimeWith(llm), NOTES);
  assert.deepEqual(findings.filter((f) => f.code === 'semantic-conflict'), []);
  assert.match(findings.find((f) => f.code === 'semantic-unavailable').message, /对不上真实文件名/);
});

test('detectConflicts：代码围栏里的 JSON 也能解（模型很爱加 ```json）', async () => {
  const llm = fakeLlm(textPlay('```json\n' + CONFLICT_JSON + '\n```'));
  const findings = await detectConflicts(runtimeWith(llm), NOTES);
  assert.equal(findings.filter((f) => f.code === 'semantic-conflict').length, 1);
});

test('detectConflicts：模型报「没有矛盾」时零 findings（空数组不是不可用）', async () => {
  const llm = fakeLlm(textPlay('[]'));
  assert.deepEqual(await detectConflicts(runtimeWith(llm), NOTES), []);
});

test('detectConflicts：模型返回空数组、没冲突 → 恰好一条调用', async () => {
  const llm = fakeLlm(textPlay('[]'));
  await detectConflicts(runtimeWith(llm), NOTES);
  assert.equal(llm.calls.length, 1);
});

// ------------------------------------------------------- 不可用 / 失败降级

test('detectConflicts：ctx.get("llm") 为 undefined → 一条 warn 的 semantic-unavailable，不抛', async () => {
  const findings = await detectConflicts({ ctx: fakeCtx({ llm: undefined }) }, NOTES);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'semantic-unavailable');
  assert.equal(findings[0].severity, 'warn');
  assert.deepEqual(findings[0].files, []);
});

test('detectConflicts：解析不出路由 → 一条 warn，不抛也不发调用', async () => {
  const llm = fakeLlm(textPlay('[]'));
  const findings = await detectConflicts({ ctx: fakeCtx({ llm }) }, NOTES);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'warn');
  assert.match(findings[0].message, /路由/);
  assert.equal(llm.calls.length, 0);
});

test('detectConflicts：笔记为空 → 空 findings，一次调用都不发', async () => {
  const llm = fakeLlm(textPlay('[]'));
  assert.deepEqual(await detectConflicts(runtimeWith(llm), []), []);
  assert.equal(llm.calls.length, 0);
});

test('detectConflicts：调用失败（终止 chunk）不抛给 doctor，并第一次失败就停手', async () => {
  const many = Array.from({ length: MAX_NOTES_PER_CALL * 3 }, (_, i) => ({ file: `reference-n${i}.md`, title: `n${i}`, description: 'd', body: 'b' }));
  const llm = fakeLlm({ chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'MISSING_CREDENTIAL', message: '没配 key' } } }] });
  const findings = await detectConflicts(runtimeWith(llm), many);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'semantic-unavailable');
  assert.equal(findings[0].severity, 'warn');
  assert.match(findings[0].message, /MISSING_CREDENTIAL/);
  assert.match(findings[0].message, /\[llm-error\]/);
  assert.equal(llm.calls.length, 1, '失败通常不是这一批特有的，继续烧剩下的批次只是白花时间');
});

test('detectConflicts：超时也归一成 semantic-unavailable（不抛，doctor 不许被带走）', async () => {
  const findings = await detectConflicts({ ctx: fakeCtx({ llm: hangingLlm(), selection: { provider: 'p', model: 'm' } }), config: { timeoutMs: 20 } }, NOTES);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'semantic-unavailable');
  assert.match(findings[0].message, /超时/);
  assert.match(findings[0].message, /\[llm-timeout\]/);
});

// ------------------------------------------------------------ 用量上限

test('笔记数超上限：分批但调用次数封顶 MAX_CALLS，剩余与截断都如实报出', async () => {
  const total = MAX_NOTES_PER_CALL * MAX_CALLS + 5; // 85 篇 → 需要 5 批，只允许 4 批
  const notes = Array.from({ length: total }, (_, i) => ({ file: `reference-n${String(i).padStart(2, '0')}.md`, title: `n${i}`, description: 'd', body: 'b' }));
  const llm = fakeLlm(textPlay('[]'));
  const findings = await detectConflicts(runtimeWith(llm), notes);

  assert.equal(llm.calls.length, MAX_CALLS, `最多只许发 ${MAX_CALLS} 次调用`);
  const trunc = findings.find((f) => f.code === 'semantic-truncated');
  assert.ok(trunc, '截断过就必须体现在返回值里，不许假装全看过');
  assert.equal(trunc.severity, 'info');
  assert.match(trunc.message, new RegExp(`${MAX_NOTES_PER_CALL * MAX_CALLS}/${total}`));
  assert.match(trunc.message, /其余 5 篇未查/);
  // 第 80 篇在最后一批里，第 81 篇之后压根没送出去
  assert.match(sentText(llm.calls[MAX_CALLS - 1]), /reference-n79\.md/);
  assert.doesNotMatch(sentText(llm.calls[MAX_CALLS - 1]), /reference-n80\.md/);
});

test('单篇正文超长：计入 semantic-truncated，且第 1201 个字没送出去', async () => {
  const llm = fakeLlm(textPlay('[]'));
  const findings = await detectConflicts(runtimeWith(llm), [{ file: 'reference-big.md', title: 't', description: 'd', body: '字'.repeat(MAX_NOTE_CHARS + 500) }]);
  const trunc = findings.find((f) => f.code === 'semantic-truncated');
  assert.ok(trunc);
  assert.match(trunc.message, new RegExp(`1 篇正文被截断到 ${MAX_NOTE_CHARS} 字符`));
  const sent = sentText(llm.calls[0]);
  assert.ok(sent.includes('字'.repeat(MAX_NOTE_CHARS)));
  assert.ok(!sent.includes('字'.repeat(MAX_NOTE_CHARS + 1)));
});

// ------------------------------------------------- 默认关闭 / 零依赖自检

test('默认关闭：import 模块本身不发任何调用、不读 ctx（重新求值一次也一样）', async () => {
  const ctx = fakeCtx({ llm: fakeLlm(textPlay('绝不该被调用')) });
  const fresh = await import(`../llm.js?fresh=${Date.now()}`);
  assert.equal(ctx.getCalls, 0, 'import 阶段不许碰 ctx');
  assert.equal(ctx.agentDefaultModel, undefined);
  for (const name of ['getLlm', 'resolveRoute', 'collectText', 'summarizeNote', 'detectConflicts']) {
    assert.equal(typeof fresh[name], 'function', `对外签名 ${name} 必须存在`);
  }
  assert.equal(ctx.getCalls, 0);
});

test('零依赖自检：llm.js 没有任何 import（宿主包解析到旧副本，写 import 就是版本错配隐患）', () => {
  const src = readFileSync(resolve(root, 'llm.js'), 'utf8');
  assert.equal(/from\s+['"][^'"]+['"]/.test(src), false, '不许出现 import ... from / export ... from');
  assert.equal(/\brequire\s*\(/.test(src), false);
  assert.equal(/\bimport\s*\(/.test(src), false, '动态 import 也不许有');
  assert.equal(/^await\s/m.test(src), false, '顶层 await 会让 import 带上副作用');
});
