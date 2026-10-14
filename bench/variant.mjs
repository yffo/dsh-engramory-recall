/**
 * 源码变体：把 bm25.js 里的某个常量换掉，产出临时模块，用来做参数消融。
 *
 * 为什么不用「把常量变成参数」：那会把调参用的口子永久留在发布代码里。
 * 变体文件写在 bench/.tmp（.gitignore 已忽略），仓库里的 bm25.js 一个字都不动。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export async function loadVariant(replacements, label) {
  let src = readFileSync(join(here, '..', 'bm25.js'), 'utf8');
  for (const [from, to] of Object.entries(replacements)) {
    // 注意：不能拿「替换前后字符串不同」当命中判据 —— 取值恰好等于原值时也是合法替换
    // （比如 EXTRA_WEIGHT 扫到 0.5 这一档），那种情况会被误判成「常量找不到」。
    if (!src.includes(from)) throw new Error(`消融变体失配：bm25.js 里没找到 \`${from}\`（${label}）—— 常量改名了就把这里一起改`);
    src = src.split(from).join(to);
  }
  const dir = join(here, '.tmp');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `bm25-${label}.mjs`);
  writeFileSync(file, src);
  return import(pathToFileURL(file).href);
}
