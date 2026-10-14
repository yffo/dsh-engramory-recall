/**
 * 写入审计：把每一次「落在记忆库里的写」记成一行 JSONL，事后可回放。
 *
 * 对标 dsh-mneme 的 `dream_runs` 审计表与灵枢的 `WRITE_TRIO`
 * （`("ok","id","committed")`——「闸门行为」与「工具故障」是两件事），
 * 但按我们的量级砍成一行一条：哪个工具、什么时候、动哪个文件、多大、
 * 放行还是拒绝、依据哪一版规则。
 *
 * 为什么要落盘：召回日志（index.js 的 recallLog）在内存里、重启即清空，
 * 而「库里什么时候多了两篇没有 frontmatter 的裸 markdown」这类问题，
 * 恰恰要事后才问得出来——那两篇就是脚本绕过闸门写进去的。
 *
 * policy_epoch：规则版本。闸门规则一旦调整，旧裁决就不再代表当前口径；
 * 带上 epoch 之后，回放时能区分「按今天的规则它会被拒」与「当时按旧规则放行了」。
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 闸门规则版本。规则语义有变就 +1（改判据、加检查项、改阈值都算）。 */
export const GUARD_EPOCH = 'guard-v1';

export const AUDIT_FILE = '.engramory-audit.jsonl';

/** 审计文件体积上限；超了只留后半。审计不能无限增长。 */
const MAX_AUDIT_BYTES = 512 * 1024;

/**
 * 追加一条审计记录。**永不抛异常**——审计失败绝不能影响写入本身。
 * @param {string} storePath 记忆库目录
 * @param {object} entry `{ tool, file, bytes, verdict, reason? }`
 */
export function appendAudit(storePath, entry) {
  if (!storePath) return;
  try {
    mkdirSync(storePath, { recursive: true });
    const file = path.join(storePath, AUDIT_FILE);
    try {
      const size = statSync(file).size;
      if (size > MAX_AUDIT_BYTES) {
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
        writeFileSync(file, lines.slice(-Math.floor(lines.length / 2)).join('\n') + '\n');
      }
    } catch {
      // 文件还不存在：正常路径，不需要处理
    }
    appendFileSync(file, `${JSON.stringify({ ts: Date.now(), epoch: GUARD_EPOCH, ...entry })}\n`);
  } catch {
    // 只读挂载、磁盘满、权限问题——都不该让一次记忆写入失败
  }
}

/**
 * 读最近 `limit` 条审计记录（新的在前）。文件不存在或损坏时返回空数组。
 * @param {string} storePath 记忆库目录
 * @param {number} limit 最多返回多少条
 */
export function readAudit(storePath, limit = 40) {
  try {
    const text = readFileSync(path.join(storePath, AUDIT_FILE), 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null; // 半截行（写入中途被杀）直接跳过
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
