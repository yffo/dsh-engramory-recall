#!/usr/bin/env node
/**
 * `bench/eval-answerer-deepseek.mjs` —— `recall-eval.mjs --answerer cmd` 的真回答器。
 *
 * 契约（见 `recall-eval.mjs` 的 `askAnswerer`）：
 *   - stdin 收到「该臂注入的上下文 + 空行 + 题面」整段；
 *   - stdout 就是答案文本（判分器只认 stdout）；
 *   - 退出码非 0 = 回答器挂了，该题判失败并记 `answererError`。
 *
 * 所以这个文件只做三件事：读 stdin → 调一次 chat/completions → 把正文打到 stdout。
 *
 * 密钥**不落盘、不打印**：从 `DSH_EVAL_API_KEY` 环境变量读；没有就去
 * `~/.dsh/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY` 里取（只读，不回显）。
 * 任何错误路径都不把密钥写进 stderr —— 评测结果会被提交/贴进文档，泄一次就完了。
 *
 * 用法（由 recall-eval.mjs 调用，不直接手跑）：
 *   DSH_EVAL_API_KEY=... node bench/eval-answerer-deepseek.mjs < bench/.tmp/answerer-input.txt
 *
 * 可调项（都用环境变量，便于「同一回答器、换一个参数」复跑对照）：
 *   DSH_EVAL_MODEL      默认 deepseek-flash（与 DSH 桌面档 agent-default-model 同款）
 *   DSH_EVAL_THINKING   off | high   默认 off（非思考模式：快、便宜、跨三臂最公平）
 *   DSH_EVAL_TEMPERATURE 默认 0
 *   DSH_EVAL_MAXTOKENS   默认 600
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MODEL = process.env.DSH_EVAL_MODEL || 'deepseek-flash';
const THINKING = process.env.DSH_EVAL_THINKING || 'off';
const TEMPERATURE = Number(process.env.DSH_EVAL_TEMPERATURE ?? 0);
const MAX_TOKENS = Number(process.env.DSH_EVAL_MAXTOKENS ?? 600);
const BASE_URL = process.env.DSH_EVAL_BASE_URL || 'https://api.deepseek.com';
const KEY_REF = 'DEEPSEEK_API_KEY';

/** 从 ~/.dsh/.credentials.yaml 的 refs 段取密钥。只做这一件事，取不到就抛（不打印内容）。 */
function keyFromCredentialsFile() {
  const path = join(homedir(), '.dsh', '.credentials.yaml');
  let src;
  try {
    src = readFileSync(path, 'utf8');
  } catch {
    return '';
  }
  // 只扫 refs 段之后的行，避免误抓 payload 里别的字段。
  const at = src.indexOf('\nrefs:');
  const tail = at === -1 ? src : src.slice(at);
  for (const line of tail.split('\n')) {
    const m = line.match(/^\s+([A-Z0-9_]+)\s*:\s*(\S+)\s*$/);
    if (m && m[1] === KEY_REF) return m[2].replace(/^["']|["']$/g, '');
  }
  return '';
}

const apiKey = (process.env.DSH_EVAL_API_KEY || keyFromCredentialsFile()).trim();
if (!apiKey) {
  console.error('回答器：没有密钥（DSH_EVAL_API_KEY 未设，且凭据文件里没有 refs.' + KEY_REF + '）');
  process.exit(2);
}

const input = readFileSync(0, 'utf8');
if (!input.trim()) {
  // 空输入不该发生（none 臂不调回答器）；真发生就回空答案，让它按「答不出来」计。
  process.stdout.write('');
  process.exit(0);
}

/**
 * 指令块：三臂逐字相同 —— 这是「同一回答器、同一 prompt 模板」的落点。
 * 唯一变化的是后面拼上来的上下文（none 臂为空、pull 臂一行、push 臂若干条指针）。
 */
const INSTRUCTIONS = process.env.DSH_EVAL_SYS || [
  '你是被评测的回答器。下面可能给出一段「记忆线索」（也可能是空的），然后是用户的问题。',
  '规则：',
  '1. 只依据给你的线索和常识作答，不要编造线索里没有的具体路径、配置值或版本号。',
  '2. 线索里有能回答问题的内容就直接答出来，用简明中文，可以带路径/键名/命令等字面量。',
  '3. 线索里确实没有答案时，直说「不知道」，不要猜。',
  '4. 直接给答案本身，不要复述题目，不要解释你的推理过程。',
  '5. 控制在 120 字以内。',
].join('\n');

const body = {
  model: MODEL,
  messages: [
    { role: 'system', content: INSTRUCTIONS },
    { role: 'user', content: input },
  ],
  temperature: TEMPERATURE,
  max_tokens: MAX_TOKENS,
  stream: false,
};
if (THINKING === 'off') body.thinking = { type: 'disabled' };
else body.thinking = { type: 'enabled' };
if (THINKING !== 'off') body.reasoning_effort = THINKING;

let res;
try {
  res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(110000),
  });
} catch (err) {
  console.error(`回答器：请求失败 ${err.name || ''} ${err.message || ''}`.trim());
  process.exit(3);
}

if (!res.ok) {
  const text = await res.text().catch(() => '');
  // 只留状态码与前 200 字响应体：响应体里不会有密钥，但也不多留。
  console.error(`回答器：HTTP ${res.status} ${String(text).slice(0, 200)}`);
  process.exit(4);
}

const json = await res.json();
const text = json?.choices?.[0]?.message?.content ?? '';
process.stdout.write(String(text).trim());

// 用量走 stderr，方便复跑时对账（recall-eval 只收 stdout，不会污染答案）。
// 另可选用 DSH_EVAL_USAGE_LOG 追加一行 JSONL：算成本要精确的 prompt/completion 数，
// 而 recall-eval 只读 stdout、丢弃 stderr，所以必须落一个文件才拿得到账。
const u = json?.usage;
if (u) {
  console.error(
    `[usage] model=${MODEL} thinking=${THINKING} prompt=${u.prompt_tokens ?? '?'} ` +
      `completion=${u.completion_tokens ?? '?'} total=${u.total_tokens ?? '?'}`,
  );
  if (process.env.DSH_EVAL_USAGE_LOG) {
    try {
      appendFileSync(
        process.env.DSH_EVAL_USAGE_LOG,
        `${JSON.stringify({
          at: new Date().toISOString(),
          model: MODEL,
          thinking: THINKING,
          promptTokens: u.prompt_tokens ?? null,
          completionTokens: u.completion_tokens ?? null,
          totalTokens: u.total_tokens ?? null,
          cachedTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? null,
        })}\n`,
      );
    } catch {
      /* 记不上账不该让整轮评测挂掉 —— 账是副产品，答案是主产品。 */
    }
  }
}
