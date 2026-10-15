/**
 * 技能注册的测试。
 *
 * 这套用例守的是**纪律有没有被写进正文**：技能正文承载的正是「什么时候该记、
 * 什么时候不该记」这套规矩，而它最容易出的不是语法错误，而是**边界被悄悄放松**
 * （比如「问候不算任务」那句话没了），而那不会有任何报错。
 *
 * 断言按纪律逐条写，一条纪律至少一条断言；措辞可以改，纪律少一条这组用例就得报错。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SKILL_DESCRIPTION, SKILL_NAME, SKILL_WHEN_TO_USE, registerSkill, skillBody, skillStatus } from '../skill.js';

/** 造一个假的 ctx，记录注册了什么、effect 有没有被调用。 */
function fakeCtx({ injectThrows = false, registerThrows = false } = {}) {
  const calls = { injected: [], registered: [], effects: 0 };
  const ctx = {
    inject(services, fn) {
      calls.injected.push(services);
      if (injectThrows) throw new Error('skills registry not available');
      const inner = {
        effect(fn2) {
          calls.effects += 1;
          return fn2();
        },
        skills: {
          register(entry) {
            if (registerThrows) throw new Error('duplicate skill name');
            calls.registered.push(entry);
            return () => {};
          },
        },
      };
      fn(inner);
    },
  };
  return { ctx, calls };
}

/**
 * 另一种假的 ctx：注入回调**延迟**执行 —— 技能注册表晚于本插件激活时就是这个时序，
 * flush() 用来手动触发回调并拿到它抛出的异常。
 */
function deferredCtx({ registerThrows = false } = {}) {
  const calls = { injected: [], registered: [], effects: 0, pending: [] };
  const ctx = {
    inject(services, fn) {
      calls.injected.push(services);
      calls.pending.push(fn);
    },
  };
  const flush = () => {
    for (const fn of calls.pending.splice(0)) {
      fn({
        effect(fn2) {
          calls.effects += 1;
          return fn2();
        },
        skills: {
          register(entry) {
            if (registerThrows) throw new Error('duplicate skill name');
            calls.registered.push(entry);
            return () => {};
          },
        },
      });
    }
  };
  return { ctx, calls, flush };
}

describe('技能：正文里的纪律不能被写丢', () => {
  const body = skillBody();

  it('技能名与 description —— 名字保持 engramory，描述要讲清它管什么', () => {
    assert.equal(SKILL_NAME, 'engramory');
    assert.ok(SKILL_DESCRIPTION.trim().length > 200, '描述不能缩水成一句话，它决定模型什么时候想起来有这个技能');
    assert.match(SKILL_DESCRIPTION, /MEMORY\.md/);
    assert.match(SKILL_DESCRIPTION, /user\/feedback\/project\/reference/);
    assert.match(SKILL_DESCRIPTION, /curation checkpoint/);
    assert.match(SKILL_DESCRIPTION, /compact|clear|fresh thread/);
  });

  it('description 里也要有「问候不算任务」，且不许按长度判断', () => {
    assert.match(SKILL_DESCRIPTION, /greeting/);
    assert.match(SKILL_DESCRIPTION, /acknowledgement/);
    assert.match(SKILL_DESCRIPTION, /not a task/);
    assert.match(SKILL_DESCRIPTION, /by length/);
  });

  it('whenToUse 覆盖三类触发 + 不该用的那一类 + 拿不准怎么办', () => {
    assert.match(SKILL_WHEN_TO_USE, /^Starting or resuming/);
    assert.match(SKILL_WHEN_TO_USE, /durable/);
    assert.match(SKILL_WHEN_TO_USE, /nothing worth (keeping|saving)/);
    assert.match(SKILL_WHEN_TO_USE, /compact\/clear\/new-thread/);
    assert.match(SKILL_WHEN_TO_USE, /Not for a bare greeting/);
    assert.match(SKILL_WHEN_TO_USE, /continues work underway/);
    assert.match(SKILL_WHEN_TO_USE, /pasted diff/);
    assert.match(SKILL_WHEN_TO_USE, /Treat it as a task/);
  });

  it('纪律①：问候/确认/反应不算任务，既没有召回也没有收尾检查', () => {
    assert.match(body, /A greeting, an\s+acknowledgement, a reaction — none of them starts work/);
    assert.match(body, /none of them gets\s+recall or a checkpoint/);
  });

  it('纪律②：任务＝处理得当可能依赖记忆库的用户指使；只读的分析/评审也算', () => {
    assert.match(body, /user-directed work whose CORRECT handling could\s+depend on/);
    assert.match(body, /read-only work counts/);
    assert.match(body, /changing a file is not required/);
  });

  it('纪律③：「手里有材料」不等于不是任务', () => {
    assert.match(body, /HAVING THE MATERIAL IN HAND does not make work a non-task/);
    assert.match(body, /a diff\s+pasted for review is still a task/);
  });

  it('纪律④：绝不用长度判断，拿不准就当任务', () => {
    assert.match(body, /NEVER INFER THIS FROM LENGTH/);
    assert.match(body, /inherits that task/);
    assert.match(body, /Treat it as a task/);
  });

  it('纪律⑤：召回是显式的 —— 先读索引、只开钩子相关的笔记', () => {
    assert.match(body, /the index is the first thing to read; open only those notes\s+whose hooks look\s+relevant/);
    assert.match(body, /Recall is explicit/);
  });

  it('纪律⑥：回忆是可能过期的背景，动手前先对着仓库复核', () => {
    assert.match(body, /background that may have gone stale/);
    assert.match(body, /re-verify any file,\s+flag, or version against the repo/);
  });

  it('纪律⑦：写之前先过两道闸 —— 「值得留吗」与「安全吗（不是密钥）」', () => {
    assert.match(body, /Worth keeping — or is it already in the repo, in git\s+history, or in the instruction files\?/);
    assert.match(body, /Safe to keep — or is it a secret value\?/);
  });

  it('纪律⑧：先搜索引，能改就改，不加近似重复的第二条', () => {
    assert.match(body, /if a note already covers it, update that note instead of\s+adding a near-duplicate/);
  });

  it('纪律⑨：一事一文 + frontmatter 字段与四类事实', () => {
    assert.match(body, /A new note is one atomic fact, with frontmatter/);
    assert.match(body, /type: user \| feedback \| project \| reference/);
    assert.match(body, /^---$/m);
    assert.match(body, /name: <kebab-case-slug>/);
    assert.match(body, /created: YYYY-MM-DD/);
    assert.match(body, /updated: YYYY-MM-DD/);
  });

  it('纪律⑩：feedback/project 必带 Why 与 How to apply；索引里只加一条指针；错的记忆要删', () => {
    assert.match(body, /`feedback` or `project` note is incomplete without two extra lines, `\*\*Why:\*\*`/);
    assert.match(body, /`\*\*How to apply:\*\*`/);
    assert.match(body, /exactly one pointer line in the index/);
    assert.match(body, /a memory that turns out to be wrong gets deleted/);
  });

  it('纪律⑪：只记 settled 事实，版本号/commit/测试通过数会腐烂 —— 记住去哪儿读', () => {
    assert.match(body, /What to keep: settled facts/);
    assert.match(body, /tip commit, or a passing test count rots/);
    assert.match(body, /record\s+where to read those instead/);
  });

  it('纪律⑫：未完成任务至多一条活笔记 —— 是上限不是配额', () => {
    assert.match(body, /AT MOST ONE live `project` note/);
    assert.match(body, /the\s+single exception to one-file-one-fact/);
    assert.match(body, /a ceiling rather than a quota/);
    assert.match(body, /needs no resumable state keeps no note at all/);
  });

  it('纪律⑬：那条活笔记就地更新，绝不写日期序列、绝不另开交接日志', () => {
    assert.match(body, /Update it IN PLACE/);
    assert.match(body, /Never a dated\s+series/);
    assert.match(body, /second handoff\s+log indexed beside it/);
    assert.match(body, /retire its transient state once the task ends/);
  });

  it('纪律⑭：收尾检查是一次判断，不是一次写入；没东西可留就什么都不写', () => {
    assert.match(body, /Run one curation checkpoint/);
    assert.match(body, /It is a call you make, not text you write/);
    assert.match(body, /when nothing is worth keeping, write\s+nothing and say so/);
  });

  it('纪律⑮：不许往记忆库追加逐轮流水，也不许只为刷新时间戳去碰文件', () => {
    assert.match(body, /Never append a per-turn log TO THE STORE/);
    assert.match(body, /never touch a\s+file just to mark it fresh/);
    assert.match(body, /a timestamp is not a memory/);
  });

  it('纪律⑯：换线程前先同步 —— 去重更新、刷新项目状态、只沉淀可复用的反馈、并报账', () => {
    assert.match(body, /Before a deliberate compact, clear, or new thread/);
    assert.match(body, /dedup and\s+update/);
    assert.match(body, /promote only reusable feedback/);
    assert.match(body, /retire completed\s+transient state/);
    assert.match(body, /report what was added, updated, archived, and skipped/);
  });

  it('纪律⑰：上限是真拒绝不是警告，缩小的重写永远放行，超限就静默失忆', () => {
    assert.match(body, /a write that would GROW the index past 200 lines \/ 25 KB/);
    assert.match(body, /a real refusal, not a warning/);
    assert.match(body, /a write that shrinks the index always passes/);
    assert.match(body, /quietly drops out of recall/);
  });

  it('上限与库路径随配置走（写死在正文里就会和面板里的实际配置对不上）', () => {
    assert.match(skillBody({ maxLines: 120, maxBytes: 10240 }), /past 120 lines \/ 10 KB/);
    assert.match(skillBody(), /~\/memory\/engramory/);
    assert.match(skillBody({ storePath: '/tmp/some-store' }), /\/tmp\/some-store/);
  });

  it('纪律⑱：绝不把凭据写进记忆 —— 只记密钥放在哪儿', () => {
    assert.match(body, /Secrets are out of scope for the store — no credentials, keys, tokens, or cookies/);
    assert.match(body, /What belongs here is the pointer: where the secret lives/);
  });

  it('本插件自己的行为要写进正文（否则模型不知道它存在）', () => {
    assert.match(body, /Auto-recall/);
    assert.match(body, /injected automatically as POINTERS/);
    assert.match(body, /They are hints, not facts/);
    assert.match(body, /A sediment nudge/);
    assert.match(body, /It is a nudge, not an instruction/);
    assert.match(body, /are refused/);
  });

  it('正文的章节骨架齐全（哪一节被整段删掉都会看得出来）', () => {
    for (const heading of [
      '# Engramory — curated file-based memory',
      '## Which turns count',
      '## Recall',
      '## Write',
      '## When a task finishes',
      '## Sync',
      '## The index cap is enforced here',
      '## What this plugin does on its own',
    ]) {
      assert.ok(body.includes(heading), `缺章节：${heading}`);
    }
  });
});

describe('技能：注册路径', () => {
  it('走 ctx.inject([skills]) 而不是裸读 ctx.skills', () => {
    const { ctx, calls } = fakeCtx();
    registerSkill(ctx, {});
    assert.deepEqual(calls.injected, [['skills']]);
  });

  it('注册项带全 name/description/whenToUse/content/source', () => {
    const { ctx, calls } = fakeCtx();
    registerSkill(ctx, {});
    assert.equal(calls.registered.length, 1);
    const entry = calls.registered[0];
    assert.equal(entry.name, 'engramory');
    assert.equal(entry.description, SKILL_DESCRIPTION);
    assert.equal(entry.whenToUse, SKILL_WHEN_TO_USE);
    assert.equal(entry.source, 'runtime');
    assert.match(entry.content, /# Engramory — curated file-based memory/);
  });

  it('用 inner.effect() 绑定生命周期 —— 否则重载会累积重复注册', () => {
    const { ctx, calls } = fakeCtx();
    registerSkill(ctx, {});
    assert.equal(calls.effects, 1);
    assert.equal(calls.registered.length, 1);
  });

  it('registerSkill:false 时什么都不做', () => {
    const { ctx, calls } = fakeCtx();
    registerSkill(ctx, { registerSkill: false });
    assert.deepEqual(calls.injected, []);
    assert.deepEqual(calls.registered, []);
  });

  it('技能注册表不可用时静默 —— 闸门与召回不依赖它，绝不能因此拖崩宿主', () => {
    const { ctx, calls } = fakeCtx({ injectThrows: true });
    assert.doesNotThrow(() => registerSkill(ctx, {}));
    assert.deepEqual(calls.registered, []);
  });

  it('每次尝试都自报状态 —— 这条链失败是静默的，不回报就发现不了', () => {
    const ok = registerSkill(fakeCtx().ctx, {});
    assert.equal(ok.ok, true);
    assert.equal(skillStatus().name, 'engramory');

    const bad = registerSkill(fakeCtx({ injectThrows: true }).ctx, {});
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /skills registry not available/);
    assert.equal(skillStatus().ok, false, '状态要跟着更新，面板才看得出这次失败');

    const off = registerSkill(fakeCtx().ctx, { registerSkill: false });
    assert.equal(off.ok, false);
    assert.equal(off.reason, 'disabled');
  });

  it('重名注册抛错时也吞掉 —— 与上游插件同时装着，绝不能因为一个技能名把宿主拖崩', () => {
    const { ctx, calls } = fakeCtx({ registerThrows: true });
    assert.doesNotThrow(() => registerSkill(ctx, {}));
    assert.deepEqual(calls.registered, []);
  });

  it('注册表晚于本插件激活时也照样注册（延迟回调，不是只靠 inject 的同步返回）', () => {
    const deferred = deferredCtx();
    const status = registerSkill(deferred.ctx, {});
    assert.equal(status.ok, true, 'inject 本身只登记回调，这一刻还不算注册完');
    assert.deepEqual(deferred.calls.injected, [['skills']]);
    assert.deepEqual(deferred.calls.registered, [], '还没 flush，回调没跑');
    deferred.flush();
    assert.equal(deferred.calls.effects, 1);
    assert.equal(deferred.calls.registered.length, 1, '回调一到就注册上');
    assert.equal(deferred.calls.registered[0].name, 'engramory');
    assert.equal(deferred.calls.registered[0].description, SKILL_DESCRIPTION);
    assert.equal(deferred.calls.registered[0].whenToUse, SKILL_WHEN_TO_USE);
    assert.match(deferred.calls.registered[0].content, /# Engramory — curated file-based memory/);
  });

  it('延迟回调里注册抛错会浮出来 —— 这层 try/catch 只兜得住同步路径，记得别把它当保险', () => {
    const deferred = deferredCtx({ registerThrows: true });
    registerSkill(deferred.ctx, {});
    assert.throws(() => deferred.flush(), /duplicate skill name/);
  });

  it('content 可注入（供测试或定制），默认才是 skillBody()', () => {
    const { ctx, calls } = fakeCtx();
    registerSkill(ctx, { skill: 'CUSTOM-BODY' });
    assert.equal(calls.registered[0].content, 'CUSTOM-BODY');
  });
});
