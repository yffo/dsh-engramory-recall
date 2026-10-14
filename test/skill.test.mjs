/**
 * 技能注册的测试。
 *
 * 这套用例守的是**融合的完整性**：技能正文是从 `dsh-engramory` 逐字搬过来的，而它
 * 承载的正是「什么时候该记、什么时候不该记」这套纪律。搬的过程中最容易出的不是语法
 * 错误，而是**边界被悄悄放松**（比如「问候不算任务」那句话没了），而那不会有任何报错。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SKILL_DESCRIPTION, SKILL_NAME, SKILL_WHEN_TO_USE, registerSkill, skillBody } from '../skill.js';

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

describe('技能：正文里的纪律不能被搬丢', () => {
  const body = skillBody();

  it('报名与身份', () => {
    assert.equal(SKILL_NAME, 'engramory');
    assert.match(SKILL_DESCRIPTION, /curated file-based long-term memory/i);
    assert.match(SKILL_WHEN_TO_USE, /Starting or resuming work/);
  });

  it('「问候不算任务」这条边界必须在 —— 它是最容易被悄悄放松的一句', () => {
    assert.match(body, /a greeting, an\s+acknowledgement, or a reaction starts none/);
    assert.match(body, /NEVER INFER\s+THIS FROM LENGTH/);
  });

  it('「手里有材料不等于不是任务」必须在', () => {
    assert.match(body, /a diff pasted for review is still a task/);
  });

  it('一条一主题与四类事实必须在', () => {
    assert.match(body, /type: user \| feedback \| project \| reference/);
    assert.match(body, /Never a dated\s+series/);
  });

  it('「不要记当前状态」必须在（版本号/测试数会腐烂）', () => {
    assert.match(body, /Store settled facts, never current state/);
    assert.match(body, /record where to read those instead/);
  });

  it('绝不写入密钥必须在', () => {
    assert.match(body, /Never write credentials, keys, tokens, or cookies/);
  });

  it('上限是「真拒绝」而不是警告，且要指出缩小的出路', () => {
    assert.match(body, /a write that would GROW the index past 200 lines \/ 25 KB/);
    assert.match(body, /a write that shrinks the index always passes/);
  });

  it('上限随配置走', () => {
    const custom = skillBody({ maxLines: 120, maxBytes: 10240 });
    assert.match(custom, /past 120 lines \/ 10 KB/);
  });

  it('库路径随配置走，且写明默认值', () => {
    assert.match(skillBody(), /~\/memory\/engramory/);
    assert.match(skillBody({ storePath: '/tmp/some-store' }), /\/tmp\/some-store/);
  });

  it('本插件自己的行为要写进正文（否则模型不知道它存在）', () => {
    assert.match(body, /Auto-recall/);
    assert.match(body, /sediment nudge/);
    assert.match(body, /POINTERS/);
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

  it('重名注册抛错时也吞掉（与 dsh-engramory 同时装着的情况）', () => {
    const { ctx } = fakeCtx({ registerThrows: true });
    assert.doesNotThrow(() => registerSkill(ctx, {}));
  });

  it('content 可注入（供测试或定制），默认才是 skillBody()', () => {
    const { ctx, calls } = fakeCtx();
    registerSkill(ctx, { skill: 'CUSTOM-BODY' });
    assert.equal(calls.registered[0].content, 'CUSTOM-BODY');
  });
});
