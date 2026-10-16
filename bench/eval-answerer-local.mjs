#!/usr/bin/env node
/**
 * 本地模型回答器（`bench/recall-eval.mjs --answerer cmd` 的 `--cmd` 端）。
 *
 * 为什么要这个文件：三臂对照此前只有一个云端回答器的数字，而「pull 到底行不行」这件事
 * 不该只有一家模型的证据。本机有可用的**本地**指令模型（GGUF，llama-server 起），
 * 于是同一套题集可以用一台**完全不出网**的回答器再量一遍 —— 零 API 成本、可复现、可重跑。
 *
 * 约定（与 `askAnswerer` 的 cmd 档一致）：
 *   stdin  = 上下文 + 空行 + 题面（三臂的**唯一**变量就是前半段），
 *   stdout = 答案正文（判分器只读 stdout）。
 *
 * 环境变量：
 *   LOCAL_BASE_URL    默认 http://127.0.0.1:8080/v1
 *   LOCAL_MODEL       默认读 /v1/models 的第一个（llama-server 只挂一个模型）
 *   LOCAL_MAX_TOKENS  默认 400
 *   LOCAL_TIMEOUT_MS  默认 120000
 *   LOCAL_SYSTEM      覆盖指令块（默认见下）；对比实验**必须三臂同一条**
 *
 * 失败时一律**退出码非 0**：判分器把非 0 记成 `回答器退出码 N`，题算没答对 ——
 * 这一档的口径是「回答器挂了与答不出来都算没答对，但 error 要留在结果里」，
 * 免得把回答器的故障读成记忆的锅。
 */

const BASE = (process.env.LOCAL_BASE_URL || 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
const MAX_TOKENS = Number(process.env.LOCAL_MAX_TOKENS) || 400;
const TIMEOUT_MS = Number(process.env.LOCAL_TIMEOUT_MS) || 120000;

/**
 * 指令块：三臂**逐字相同**，唯一变量是拼在前面的上下文。
 * 「没有就说不知道」是刻意的：不这么写，模型会用通用工程常识把题蒙出来，
 * 那样 `none` 档的地板就被人为抬高了，臂间差值也就不可信了。
 */
const SYSTEM = process.env.LOCAL_SYSTEM
  || '你只能用下面给出的线索回答问题。线索里没有的，就回答「不知道」，不要用你自己的常识补。'
  + '回答控制在 120 字以内，直接给结论。';

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

const resolveModel = async () => {
  if (process.env.LOCAL_MODEL) return process.env.LOCAL_MODEL;
  const res = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET /models ${res.status}`);
  const body = await res.json();
  const id = body?.data?.[0]?.id || body?.models?.[0]?.name;
  if (!id) throw new Error('本地服务没有可用模型');
  return id;
};

const main = async () => {
  const prompt = (await readStdin()).trim();
  if (!prompt) throw new Error('stdin 是空的');
  const model = await resolveModel();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      seed: 0,
      max_tokens: MAX_TOKENS,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`POST /chat/completions ${res.status}：${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) throw new Error('模型返回了空答案');
  process.stdout.write(text.trim());
};

main().catch((err) => {
  process.stderr.write(`本地回答器失败：${err?.message || err}\n`);
  process.exit(1);
});
