/**
 * skill.js —— 注册 `engramory` 技能。
 *
 * 技能名沿用 `engramory`（与生态一致，别改），正文承载的纪律与上游 Engramory 协议
 * 一致（MIT，见 `THIRD-PARTY-NOTICES.md`）；措辞与章节结构是本仓库自己的。
 *
 * 为什么连技能一起收进来：上游那个插件一共只做两件事 —— 索引上限闸门（已收进
 * `index-guard.js`）和这个技能。两件都进来之后它才能退场，本插件才真的是
 * 「完整的记忆系统」。
 *
 * 正文末尾另有一节写本插件自己新增的行为（自动召回、沉淀提醒、体检、归档）：
 * 那些是同一个系统的行为，不写进技能里，模型就不知道它存在。
 */

/** 技能名。与生态里同名的技能保持一致，行为一致。 */
export const SKILL_NAME = 'engramory';

/**
 * 技能描述。回答的是「什么时候该想起来有这个技能」：
 * 开工时读索引、值得留下的写下来、收尾时做一次取舍、换线程前先同步。
 */
export const SKILL_DESCRIPTION =
  'Curated file-based long-term memory: at the start of a task, recall through the ' +
  'MEMORY.md index and open only the notes that look relevant; save durable ' +
  'user/feedback/project/reference facts as they settle; run a curation checkpoint ' +
  'when a task ends, even if it ends in nothing worth saving; and sync before ' +
  'compacting, clearing, or opening a fresh thread. A turn that starts no work — a ' +
  'greeting, an acknowledgement, a reaction — is not a task and calls for none of ' +
  'this; but never judge that by length, because a one-word reply that carries on ' +
  'work already underway belongs to that task.';

/** 何时该用它：三类触发的边界，以及不该用的那一类。 */
export const SKILL_WHEN_TO_USE =
  'Starting or resuming a task; something durable gets settled that a future ' +
  'session would want; a task is wrapping up — including one that leaves nothing ' +
  'worth keeping, since the checkpoint is a decision either way; or a ' +
  'compact/clear/new-thread boundary is coming up. Not for a bare greeting, ' +
  'acknowledgement, or reaction — that starts no task. A terse reply that continues ' +
  'work underway does start one, and material already in hand (a pasted diff to ' +
  'review) does not make work a non-task. Unsure? Treat it as a task.';

/**
 * 技能正文（按需拉取的那部分细节）。
 *
 * 逐条纪律：Recognition（边界）/ Recall（只读钩子、回忆当真会过期）/
 * Write（先查重、一事一文与 frontmatter、要记什么与不要记什么、未完成任务的那条活笔记）/
 * Closing checkpoint / Sync / Index cap / Secrets / 本插件自己的行为。
 */
export function skillBody({ storePath = '~/memory/engramory', maxLines = 200, maxBytes = 25600 } = {}) {
  return [
    '# Engramory — curated file-based memory',
    '',
    `One canonical store, at \`${storePath}\`. Inside it \`MEMORY.md\` is an index of`,
    'pointers — one line per memory — and every fact lives in its own small markdown',
    'file beside it. Content goes in the note, never in the index; and there is never',
    'a second, parallel store kept for handoffs. The ACTIVE store is flat: the four',
    'type names are values of the `type:` field, not subdirectories to create.',
    '`archive/` is the one reserved subdirectory — it holds notes retired out of the',
    'index.',
    '',
    '## Which turns count',
    '',
    'A turn, a message, a session is not by itself a task. A greeting, an',
    'acknowledgement, a reaction — none of them starts work, so none of them gets',
    'recall or a checkpoint. A task is user-directed work whose CORRECT handling could',
    'depend on what the store holds — read-only work counts (analysis, diagnosis,',
    'planning, review); changing a file is not required.',
    '',
    'Two traps: HAVING THE MATERIAL IN HAND does not make work a non-task — a diff',
    'pasted for review is still a task. And NEVER INFER THIS FROM LENGTH — a one-word',
    'reply that picks an option or carries on work underway inherits that task. Still',
    'unclear? Treat it as a task.',
    '',
    '## Recall',
    '',
    'When a task starts, the index is the first thing to read; open only those notes',
    'whose hooks look relevant. Recall is explicit — nothing is loaded that you did',
    'not open. And whatever comes back is background that may have gone stale:',
    're-verify any file, flag, or version against the repo before you act on it.',
    '',
    '## Write',
    '',
    'Two questions first. Worth keeping — or is it already in the repo, in git',
    'history, or in the instruction files? Safe to keep — or is it a secret value?',
    'Then search the index: if a note already covers it, update that note instead of',
    'adding a near-duplicate. A new note is one atomic fact, with frontmatter:',
    '',
    '```markdown',
    '---',
    'name: <kebab-case-slug>',
    'description: <one sharp line — this is what future-you reads to decide to open it>',
    'type: user | feedback | project | reference',
    'scope: global | repo        # optional: does this still hold in another repo?',
    'created: YYYY-MM-DD',
    'updated: YYYY-MM-DD',
    '---',
    '```',
    '',
    'A `feedback` or `project` note is incomplete without two extra lines, `**Why:**`',
    'and `**How to apply:**`. A note earns exactly one pointer line in the index, and',
    'a memory that turns out to be wrong gets deleted.',
    '',
    'What to keep: settled facts. "2.0 shipped on 2026-01-15" is durable; "the current',
    'version is X", the tip commit, or a passing test count rots within days — record',
    'where to read those instead.',
    '',
    'An unfinished task may keep AT MOST ONE live `project` note, holding its goal,',
    'status, decisions, constraints, blockers, and next step together. That is the',
    'single exception to one-file-one-fact, a ceiling rather than a quota: a task that',
    'needs no resumable state keeps no note at all. Update it IN PLACE. Never a dated',
    'series (`state-2026-01-15.md`, `state-2026-01-16.md`, …), never a second handoff',
    'log indexed beside it, and retire its transient state once the task ends.',
    '',
    '## When a task finishes',
    '',
    'Run one curation checkpoint. It is a call you make, not text you write: promote',
    'what is durable, retire whatever transient state the CURRENT task left on its own',
    'live `project` note if it has one, and when nothing is worth keeping, write',
    'nothing and say so. Never append a per-turn log TO THE STORE, and never touch a',
    'file just to mark it fresh — a timestamp is not a memory.',
    '',
    '## Sync',
    '',
    'Before a deliberate compact, clear, or new thread: scan the task, dedup and',
    'update, refresh project state, promote only reusable feedback, retire completed',
    'transient state, then report what was added, updated, archived, and skipped.',
    '',
    '## The index cap is enforced here',
    '',
    `This host denies a write that would GROW the index past ${maxLines} lines / ` +
      `${Math.round(maxBytes / 1024)} KB. That is`,
    'a real refusal, not a warning — but a write that shrinks the index always passes,',
    'so shrink it first, in as many steps as it takes. The index is loaded on every',
    'session, and whatever sits past the cap quietly drops out of recall.',
    '',
    'Secrets are out of scope for the store — no credentials, keys, tokens, or cookies,',
    'ever. What belongs here is the pointer: where the secret lives.',
    '',
    '## What this plugin does on its own',
    '',
    'The store is indexed and searched locally (BM25 over Chinese character bigrams;',
    'no embedding, no network). Two things happen without being asked for:',
    '',
    '- **Auto-recall.** On a task turn, a few notes whose hooks match the request are',
    'injected automatically as POINTERS. They are hints, not facts — open the file',
    'before relying on it. If nothing matches, nothing is injected.',
    '- **A sediment nudge.** After many turns with no write to the store, one reminder',
    'is injected suggesting a checkpoint. It is a nudge, not an instruction: if',
    'nothing durable was settled, writing nothing is the correct response.',
    '',
    'A write to a memory file is gated: bad filenames, missing frontmatter, oversized',
    'notes and anything that looks like a real credential are refused. The memory pane',
    '(`记忆` in settings) shows recall logs, a read-only doctor and index inspection.',
  ].join('\n');
}

/**
 * 注册技能。行为与上游一致（其 `index.js:84-112` 那一段），两个坑照旧要讲清楚：
 *  - 用 `ctx.inject(['skills'], …)` 而不是在这里直接读 `ctx.skills` ——
 *    技能注册表可能在本插件**之后**才激活，一次性探测会静默漏注册；
 *    而且在这一层裸读未声明的服务会抛（上游记的 issue #8 崩溃）。
 *  - 用 `inner.effect(…)` 把注册绑到子 fiber，卸载时随之释放，
 *    否则重载会累积重复注册。
 *
 * 与上游插件打交道的注意点：两者若同时装着，会注册**同名**技能，只会生效一个
 * （注册表说了算，本插件不抢也不覆盖）。这里仍包一层 try/catch —— 万一注册表
 * 对重名是抛错而非覆盖，也绝不能因为一个技能名把整个宿主拖崩。
 */
export function registerSkill(ctx, options = {}) {
  if (options.registerSkill === false) return { ok: false, reason: 'disabled' };
  try {
    ctx.inject(['skills'], (inner) => {
      const content = options.skill ?? skillBody(options);
      inner.effect(() =>
        inner.skills.register({
          name: SKILL_NAME,
          description: SKILL_DESCRIPTION,
          whenToUse: SKILL_WHEN_TO_USE,
          source: 'runtime',
          content,
        }),
      );
    });
    // 自报状态：注册这条链是**同步失败、静默失败**的（注入表可能还没就绪、
    // 或者同名技能已被上游插件注册而注册表选择抛错）。不回报，
    // 摘掉那个插件之后才发现技能根本没注册，就太晚了 —— 那正是本函数存在的唯一目的。
    lastSkillStatus = { ok: true, reason: 'injected' };
  } catch (err) {
    // 技能注册表不可用照常工作：闸门与召回都不依赖它。
    lastSkillStatus = { ok: false, reason: String(err?.message ?? err) };
  }
  return lastSkillStatus;
}

/**
 * 最近一次注册尝试的结果。暴露给面板与状态接口，用来回答
 * 「技能到底注册上了没有」—— 这条链失败时是静默的。
 */
let lastSkillStatus = { ok: false, reason: 'not-attempted' };

export function skillStatus() {
  return { ...lastSkillStatus, name: SKILL_NAME };
}
