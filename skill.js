/**
 * skill.js —— 注册 `engramory` 技能。
 *
 * **融合自 `dsh-engramory` v0.2.5 的 `builtinSkillBody()`（其 `index.js:370-454`）
 * 与它的 `ctx.inject(['skills'], …)` 注册块（`index.js:91-118`）。**
 *
 * 为什么连技能一起收进来：那个插件一共只做两件事 —— 索引上限闸门（已收进
 * `index-guard.js`）和这个技能。两件都进来之后它才能退场，本插件才真的是
 * 「完整的记忆系统」。
 *
 * 正文与 description/whenToUse **逐字保留**它的措辞：那些句子是被反复打磨过的
 * （尤其是「问候不算任务」那一段的边界），改一个字都可能松动纪律。我们只在末尾
 * 追加一节描述本插件自己新增的行为（自动召回、沉淀提醒、体检、归档）。
 */

/** 技能名。与 dsh-engramory 用同一个名字，行为一致。 */
export const SKILL_NAME = 'engramory';

/**
 * 技能描述。逐字来自 dsh-engramory（`index.js:98-113`）——
 * 它回答的是「什么时候该想起来有这个技能」。
 */
export const SKILL_DESCRIPTION =
  'Curated file-based long-term memory: recall through MEMORY.md at the start of ' +
  'a task, save durable user/feedback/project/reference facts, run a curation ' +
  'checkpoint when a task finishes, and sync before compacting or opening a ' +
  'fresh thread. A turn that starts no work — a greeting, an acknowledgement — ' +
  'is not a task and needs none of this, but never judge that by length: a ' +
  'one-word reply continuing work underway inherits that task.';

/** 何时该用它。逐字来自 dsh-engramory（`index.js:105-113`）。 */
export const SKILL_WHEN_TO_USE =
  'Starting or resuming work, learning something durable worth a future session, ' +
  'finishing a task — including one that leaves nothing worth saving, since the ' +
  'checkpoint is still a decision to make — or approaching a ' +
  'compact/clear/new-thread boundary. Not for a bare greeting, ' +
  'acknowledgement, or reaction, which starts no task — but a terse reply ' +
  'that continues work underway does, and material already in hand (a ' +
  'pasted diff to review) does not make work a non-task. Unsure? Treat it ' +
  'as a task.';

/**
 * 技能正文（按需拉取的那部分细节）。
 *
 * 「纪律」那几节（Recall / Write / 任务结束时 / Sync / 上限）是 dsh-engramory 的原文；
 * 末尾「本插件另外做了什么」一节是我们加的，描述自动召回、沉淀提醒、体检与归档 ——
 * 这些是同一个系统的行为，不写进技能里，模型就不知道它存在。
 */
export function skillBody({ storePath = '~/memory/engramory', maxLines = 200, maxBytes = 25600 } = {}) {
  return [
    '# Engramory — curated file-based memory',
    '',
    `One canonical store at \`${storePath}\`: \`MEMORY.md\` is an index of pointers, one`,
    'line per memory; each fact lives in its own small markdown file beside it. Never',
    'put content in the index, and never keep a second parallel store for handoffs.',
    'The ACTIVE store is flat — the four type names are values of the `type:` field,',
    'not subdirectories to create; `archive/` is the one reserved subdirectory, for',
    'notes retired out of the index.',
    '',
    '## Recall',
    '',
    'A turn, a message, or a session is NOT BY ITSELF a task: a greeting, an',
    'acknowledgement, or a reaction starts none, so it gets no recall and no',
    'checkpoint. A task is user-directed work whose CORRECT handling could depend',
    'on what the store holds — read-only work (analysis, diagnosis, planning,',
    'review)',
    'counts, and changing a file is not required. HAVING THE MATERIAL IN HAND does',
    'not make work a non-task: a diff pasted for review is still a task. NEVER INFER',
    'THIS FROM LENGTH: a one-word reply that picks an option or carries on work',
    'underway inherits that task. Still unclear? Treat it as a task.',
    '',
    'At the start of a task, read the index and open only the notes whose hooks look',
    'relevant. Treat what you recall as background that may be stale: re-verify any',
    'file, flag, or version against the repo before acting on it.',
    '',
    '## Write',
    '',
    'Before writing, confirm the fact is not already in the repo, git history, or the',
    'instruction files, and that it is not a secret value. Search the index and update',
    'an existing note rather than adding a near-duplicate. A new note is one atomic',
    'fact with frontmatter:',
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
    '`feedback` and `project` notes MUST carry a `**Why:**` line and a',
    '`**How to apply:**` line. Add exactly one pointer line to the index, and delete',
    'memories that turn out to be wrong.',
    '',
    'Store settled facts, never current state: "2.0 shipped on 2026-01-15" is durable;',
    '"the current version is X", the tip commit, or a passing test count will rot —',
    'record where to read those instead.',
    '',
    'An unfinished task may keep AT MOST ONE live `project` note holding its goal,',
    'status, decisions, constraints, blockers, and next step together — the single',
    'exception to one-file-one-fact, and a ceiling rather than a quota: a task that',
    'needs no resumable state keeps no note. Update it IN PLACE. Never a dated',
    'series (`state-2026-01-15.md`, `state-2026-01-16.md`, …), never a second',
    'handoff log indexed beside it, and retire its transient state once it ends.',
    '',
    '## When a task finishes',
    '',
    'Run one curation checkpoint. It is a judgement, not a write: promote what is',
    'durable, retire the transient state the CURRENT task left on its own live',
    '`project` note if it has one, and when nothing is worth keeping, write',
    'nothing and say so. Never append a per-turn log TO THE STORE, and never touch',
    'a file just to mark it fresh — a timestamp is not a memory.',
    '',
    '## Sync',
    '',
    'Before a deliberate compact, clear, or new thread: scan the task, dedup and update,',
    'refresh project state, promote only reusable feedback, retire completed transient',
    'state, then report what was added, updated, archived, and skipped.',
    '',
    '## The cap is enforced here',
    '',
    `This host denies a write that would GROW the index past ${maxLines} lines / ` +
      `${Math.round(maxBytes / 1024)} KB. That is`,
    'a real refusal, not a warning — but a write that shrinks the index always passes,',
    'so compact first, step by step if needed: the index is loaded every session, and',
    'anything past the cap silently stops being recalled.',
    '',
    'Never write credentials, keys, tokens, or cookies into memory — record only where',
    'the secret lives.',
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
 * 注册技能。
 *
 * 照抄 dsh-engramory 的注册方式（其 `index.js:91-118`），包括那两条注释里的坑：
 *  - 用 `ctx.inject(['skills'], …)` 而不是在这里直接读 `ctx.skills` ——
 *    技能注册表可能在本插件**之后**才激活，一次性探测会静默漏注册；
 *    而且在这一层裸读未声明的服务会抛（原文记的 issue #8 崩溃）。
 *  - 用 `inner.effect(…)` 把注册绑到子 fiber，卸载时随之释放，
 *    否则重载会累积重复注册。
 *
 * 与 dsh-engramory 打交道的注意点：两者若同时装着，会注册**同名**技能。
 * 正文与描述是逐字一致的，所以谁赢都一样；这里仍包一层 try/catch ——
 * 万一注册表对重名是抛错而非覆盖，绝不能因为一个技能名把整个宿主拖崩。
 */
export function registerSkill(ctx, options = {}) {
  if (options.registerSkill === false) return;
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
  } catch {
    // 技能注册表不可用照常工作：闸门与召回都不依赖它。
  }
}
