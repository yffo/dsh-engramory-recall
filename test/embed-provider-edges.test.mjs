// 参考提供方（OpenAI 兼容 embeddings）的**错误 / 边界**路径钉子。
//
// 兄弟文件 test/embed-provider.test.mjs 用本地假 HTTP 服务器走「正常链路 + 一两个错误码」；
// 这一个文件专钉它没碰到的分支，手法是**不打任何服务器**：
//   · globalThis.fetch 换成记账用的假函数（纯内存、零网络、零等待）；
//   · 需要「等待重试时被 abort」时用真 AbortController + 0ms 定时器（不是真等 5 秒）；
//   · 需要模块主块（`--check` / isMain）时用带 query 的动态 import 拿一份**全新模块实例**。
//
// 纪律：每个用例在 finally 里恢复 globalThis.fetch / console / process.argv / process.exitCode / process.env，
// 绝不外溢到同进程里的其它测试；本文件发不出任何真实网络请求。
//
// 已知环境事实：~/.config/engramory/embed.json 在本机**存在**，所以凡是用 readConfig() 的用例
// 都必须显式把 ENGRAMORY_EMBED_CONFIG 指到一个不存在的路径，否则会读到真配置。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const KEY = 'sk-test-EDGE-SECRET-must-not-leak';
const MODULE_PATH = fileURLToPath(new URL('../providers/openai-embeddings.mjs', import.meta.url));
const NO_CONFIG = '/nonexistent/engramory-embed-edge/embed.json';
const REMOTE_BASE = 'https://embed.invalid/v1'; // .invalid 是保留域名：万一漏接了桩也只是解析失败，打不到真端点
const REAL_FETCH = globalThis.fetch;

let seq = 0;

/**
 * 造一份显式配置：每个用例一个**独一无二的 model**，因为模块内有进程级 embedding 缓存
 * （键是 `model\0text`）—— 用同一个 model 配同一段文本，第二个用例会直接命中缓存而不发请求，
 * 请求计数断言就全废了。
 */
function cfgOf(overrides = {}) {
  seq += 1;
  return {
    baseUrl: REMOTE_BASE,
    local: false,
    model: `fake-edge-${seq}`,
    batch: 32,
    maxChars: 1200,
    queryPrefix: '',
    docPrefix: '',
    apiKey: KEY,
    ...overrides,
  };
}

/** 把 globalThis.fetch 换成假函数并记下每次调用（返回调用数组）。调用方负责在 finally 里还原。 */
function withFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    return handler(url, init, calls.length);
  };
  return calls;
}

function restoreFetch() {
  globalThis.fetch = REAL_FETCH;
}

/** 造一个够用的 Response 替身（模块只用到 ok / status / headers.get / text）。 */
function reply(status, body, headers = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    text: async () => body,
  };
}

/** 造一个 200 + data 数组的应答。 */
function okRows(embeddings) {
  return reply(200, JSON.stringify({ data: embeddings.map((embedding, index) => ({ embedding, index })) }));
}

const DOC = { id: 'a.md', snippet: '缓存 cache 的失效策略' };

/** 临时改若干环境变量，返回还原函数。 */
function withEnv(values) {
  const saved = new Map();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** 取一份**全新**的模块实例（query 串绕过 ESM 缓存），用于钉模块加载期的分支。 */
function importFresh(tag) {
  seq += 1;
  return import(`../providers/openai-embeddings.mjs?${tag}=${seq}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 模块主块：为什么这三份实例在**文件求值时**就一次性加载完，而且最后一份必须留给自己用
// ─────────────────────────────────────────────────────────────────────────────
//
// Node 的 `--experimental-test-coverage` 是**按文件路径**归并覆盖率的：同一个文件被加载成多个脚本实例时
// （`import('…mjs?x=1')` 就是一份独立实例），**只有最后加载的那一份的覆盖率会被留下**，先前实例的整份丢失。
// 所以：
//   · 四份实例都在这里（任何 test 之前）加载完，最后加载的 BOOT 才是覆盖率报告里那份，
//     于是功能用例也必须用 BOOT 的导出（用的是同一份实例），否则功能路径一样点不亮；
//     —— 注意：**测试体里绝不能再 import 一份新实例**，否则它会把 BOOT 的覆盖率整份顶掉；
//   · `--check` 的两条互斥分支没法在同一份实例里都跑到：350 行 `!includes('--check')` 为真时走 351（打印用法）
//     并就此结束，为假时才走 353-366。所以 **351 这一行注定点不亮**（它由「打印用法」用例断言，但不进覆盖率）。

/** 在假的 argv / 假的环境变量 / 静音的 console 下加载一份全新实例，跑完立刻全部还原。 */
async function bootScenario(tag, { argv = ['/nonexistent/engramory-entry.mjs'], env = {}, fetch: handler, logThrowsAfter = 0 } = {}) {
  const savedArgv = process.argv.slice();
  const savedExit = process.exitCode;
  const restoreEnv = withEnv(env);
  const realLog = console.log;
  const realError = console.error;
  const logs = [];
  const errs = [];
  const calls = [];
  let exitCode;
  let mod;
  let error;
  if (handler) {
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
      return handler(url, init, calls.length);
    };
  }
  console.log = (...args) => {
    logs.push(args.map(String).join(' '));
    // 第 N 行先写进 logs，再抛：模拟 EPIPE（下游 `| head -1` 关掉了管道），用来钉主块 catch 那一支
    if (logThrowsAfter && logs.length >= logThrowsAfter) throw new Error('EPIPE: 标准输出写不进去了（下游已经关了）');
  };
  console.error = (...args) => errs.push(args.map(String).join(' '));
  process.argv.length = 0;
  process.argv.push(savedArgv[0] ?? process.execPath, ...argv);
  try {
    mod = await importFresh(tag);
  } catch (caught) {
    error = caught;
  } finally {
    process.argv.length = 0;
    process.argv.push(...savedArgv);
    exitCode = process.exitCode;
    process.exitCode = savedExit;
    restoreEnv();
    console.log = realLog;
    console.error = realError;
    restoreFetch();
  }
  return { mod, error, logs, errs, calls, exitCode };
}

const CHECK_ENV = {
  ENGRAMORY_EMBED_CONFIG: NO_CONFIG,
  ENGRAMORY_EMBED_API_KEY: KEY,
  ENGRAMORY_EMBED_API_KEY_FILE: undefined,
  ENGRAMORY_EMBED_BASE_URL: REMOTE_BASE,
  ENGRAMORY_EMBED_MODEL: 'fake-edge-check',
};

// 场景一：`--check --json`
const scenarioJson = await bootScenario('check-json', {
  argv: ['/nonexistent/entry.mjs', '--check', '--json'],
  env: CHECK_ENV,
  fetch: () => okRows([[1, 0, 0, 0]]),
});

// 场景二：argv[1] 就是模块自己（isMain 为真）且没带 --check → 打印用法
const scenarioUsage = await bootScenario('usage', {
  argv: [MODULE_PATH],
  env: CHECK_ENV,
  fetch: () => {
    throw new Error('打印用法的分支不该发请求');
  },
});

// 场景三：`--check` 但没配密钥 → 走主块的 catch（✗ + 退出码 1）
const scenarioCheckFail = await bootScenario('check-fail', {
  argv: ['/nonexistent/entry.mjs', '--check'],
  env: {
    ENGRAMORY_EMBED_CONFIG: NO_CONFIG,
    ENGRAMORY_EMBED_API_KEY: undefined,
    ENGRAMORY_EMBED_API_KEY_FILE: undefined,
    ENGRAMORY_EMBED_BASE_URL: REMOTE_BASE,
  },
  fetch: () => {
    throw new Error('没配密钥的场景不该走到发请求');
  },
});

// 场景四（必须是最后一份，见上面的说明）：`--check` 的人类可读分支 + 输出层 EPIPE → 主块 catch
const BOOT = await bootScenario('check-main', {
  argv: ['/nonexistent/entry.mjs', '--check'],
  env: { ...CHECK_ENV, ENGRAMORY_EMBED_MODEL: 'fake-edge-boot' },
  fetch: () => okRows([[1, 0, 0, 0]]),
  logThrowsAfter: 2,
});

// 下面所有功能用例都用这份实例的导出 —— 与覆盖率报告里留下的那份是同一个。
const {
  check, createProvider, isLocalEndpoint, readConfig, rerank, rerankWith,
} = BOOT.mod;

// ── 模块主块与加载期 ──────────────────────────────────────────────────────────

test('argv[1] 指向不存在的文件：isMain 的 realpathSync 抛错被吞掉，模块照常加载、主块靠 --check 进入', () => {
  assert.equal(BOOT.error, undefined, 'realpathSync 的 ENOENT 不许把模块加载带崩');
  assert.equal(BOOT.mod.name, 'openai-embeddings');
  assert.equal(typeof BOOT.mod.rerank, 'function');
  assert.equal(BOOT.calls.length, 1, '主块确实跑了（探了一次接口），而不是被 isMain 的异常打断');
});

test('--check 成功的人类可读输出：两行内容逐项钉住（模型 @ 地址、密钥来源、维度、耗时）', () => {
  assert.equal(BOOT.logs.length, 2, `实际输出：${JSON.stringify(BOOT.logs)}`);
  assert.equal(BOOT.logs[0], '✓ embeddings 可用：fake-edge-boot @ https://embed.invalid/v1');
  assert.match(BOOT.logs[1], /^ {2}密钥来源：ENGRAMORY_EMBED_API_KEY · 维度：4 · 耗时：\d+ms$/);
  assert.ok(!BOOT.logs.join('\n').includes(KEY), '自检输出里绝不许出现密钥');
  assert.equal(BOOT.calls[0].url, `${REMOTE_BASE}/embeddings`);
  assert.equal(BOOT.calls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(BOOT.calls[0].body.input.length, 1, '自检就探一条文本');
});

test('主块在写标准输出时抛错（EPIPE 式）：照样兜住，打「✗ 原话」并把 process.exitCode 置 1', () => {
  assert.equal(BOOT.errs.length, 1);
  assert.equal(BOOT.errs[0], '✗ EPIPE: 标准输出写不进去了（下游已经关了）');
  assert.equal(BOOT.exitCode, 1, '脚本要靠退出码判定成败（bootScenario 已在 finally 里还原，不污染测试进程）');
});

test('--check --json：只打一行 JSON，字段齐全且不含密钥', () => {
  assert.equal(scenarioJson.error, undefined);
  assert.deepEqual(scenarioJson.errs, []);
  assert.equal(scenarioJson.logs.length, 1, `实际输出：${JSON.stringify(scenarioJson.logs)}`);
  const parsed = JSON.parse(scenarioJson.logs[0]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dimensions, 4);
  assert.equal(parsed.model, 'fake-edge-check');
  assert.equal(parsed.keySource, 'ENGRAMORY_EMBED_API_KEY');
  assert.equal(parsed.baseUrl, REMOTE_BASE);
  assert.ok(Number.isFinite(parsed.ms));
  assert.ok(!scenarioJson.logs[0].includes(KEY));
});

test('argv[1] 就是模块自己且没带 --check：打印用法，绝不自作主张去探接口', () => {
  assert.equal(scenarioUsage.error, undefined);
  assert.equal(scenarioUsage.calls.length, 0, '光看用法不该产生任何 embedding 调用');
  assert.deepEqual(scenarioUsage.logs, ['用法：node providers/openai-embeddings.mjs --check [--json]']);
  assert.deepEqual(scenarioUsage.errs, []);
  assert.equal(scenarioUsage.exitCode, undefined);
});

test('--check 失败（没配密钥 + 远端端点）：打「✗ 没配密钥…」并把退出码置 1', () => {
  assert.equal(scenarioCheckFail.error, undefined);
  assert.equal(scenarioCheckFail.calls.length, 0, '没配密钥就不该走到发请求');
  assert.deepEqual(scenarioCheckFail.logs, []);
  assert.equal(scenarioCheckFail.errs.length, 1);
  assert.match(scenarioCheckFail.errs[0], /^✗ 没配密钥/);
  assert.match(scenarioCheckFail.errs[0], /ENGRAMORY_EMBED_API_KEY/, '得告诉用户具体填哪一项');
  assert.equal(scenarioCheckFail.exitCode, 1);
});

test('check() 直接调用：没配密钥时抛的错误要把「填哪个环境变量」和「配置文件写在哪」都说清楚', async () => {
  const calls = withFetch(() => {
    throw new Error('没配密钥就不该走到发请求');
  });
  try {
    await assert.rejects(
      () => check({
        ENGRAMORY_EMBED_CONFIG: NO_CONFIG,
        ENGRAMORY_EMBED_API_KEY: undefined,
        ENGRAMORY_EMBED_API_KEY_FILE: undefined,
        ENGRAMORY_EMBED_BASE_URL: REMOTE_BASE,
      }),
      (error) => {
        assert.match(error.message, /^没配密钥：/);
        assert.match(error.message, /ENGRAMORY_EMBED_API_KEY/, '得点名环境变量');
        assert.ok(error.message.includes(NO_CONFIG), '还得把实际会去读的配置文件路径报出来，用户才知道该往哪写');
        assert.match(error.message, /localhost \/ 127\.0\.0\.1/, '说明本机端点不用密钥，免得用户白配');
        return true;
      },
    );
    assert.equal(calls.length, 0);
  } finally {
    restoreFetch();
  }
});

// ── 密钥文件（readKey 的 file 分支） ───────────────────────────────────────────
test('密钥文件：ENGRAMORY_EMBED_API_KEY_FILE 指的文件读得到就 trim 着用，并优先于配置文件里的 apiKey', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-embed-edge-key-'));
  const file = join(dir, 'key.txt');
  const configFile = join(dir, 'embed.json');
  writeFileSync(file, `  ${KEY}\n`);
  writeFileSync(configFile, JSON.stringify({ apiKey: 'sk-from-config-file' }));
  try {
    const cfg = readConfig({
      ENGRAMORY_EMBED_CONFIG: configFile,
      ENGRAMORY_EMBED_API_KEY: undefined,
      ENGRAMORY_EMBED_API_KEY_FILE: file,
    });
    assert.equal(cfg.apiKey, KEY, '密钥文件里的换行/空格要被 trim 掉');
    assert.equal(cfg.keySource, 'ENGRAMORY_EMBED_API_KEY_FILE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('密钥文件：读不到时抛「读不到密钥文件 …（ENOENT）」，而不是悄悄当成没配密钥', () => {
  assert.throws(
    () => readConfig({
      ENGRAMORY_EMBED_CONFIG: NO_CONFIG,
      ENGRAMORY_EMBED_API_KEY: undefined,
      ENGRAMORY_EMBED_API_KEY_FILE: '/nonexistent/engramory-embed-edge/key.txt',
    }),
    (error) => {
      assert.match(error.message, /读不到密钥文件/);
      assert.match(error.message, /ENOENT/, '要把底层原因（错误码）带上，否则用户不知道是自己路径写错了');
      return true;
    },
  );
});

// ── isLocalEndpoint 的无效输入分支 ─────────────────────────────────────────────

test('isLocalEndpoint：不是合法 URL 一律 false 而不是抛错（拿它当守卫就不该被输入炸掉）', () => {
  assert.equal(isLocalEndpoint('这不是一个 URL'), false);
  assert.equal(isLocalEndpoint(''), false);
  assert.equal(isLocalEndpoint(undefined), false);
  assert.equal(isLocalEndpoint('embed.invalid/v1'), false, '没写协议头就是解析不了');
  // 正例边界一起钉住，免得上面几条把判定改坏了没人发现
  assert.equal(isLocalEndpoint('http://[::1]:11434/v1'), true);
  assert.equal(isLocalEndpoint('http://0.0.0.0:8080/v1'), true);
});

// ── HTTP 状态码：重试与否、消息形状 ────────────────────────────────────────────

test('HTTP 400：客户端错误不重试，消息带状态码 + 折叠空白并截断到 200 字的服务端原话', async () => {
  const calls = withFetch(() => reply(400, `第一行\n第二行\t${'x'.repeat(500)}`));
  try {
    await assert.rejects(
      () => rerankWith(cfgOf(), { query: 'q', docs: [DOC] }),
      (error) => {
        const prefix = 'embeddings HTTP 400：';
        assert.ok(error.message.startsWith(prefix), `实际：${error.message}`);
        assert.ok(!error.message.includes('已重试'), '400 不该走重试，也就不该出现「已重试」');
        assert.ok(!/\s\s|\n|\t/.test(error.message.slice(prefix.length)), '服务端原话里的连续空白要被折叠');
        assert.ok(error.message.length <= prefix.length + 200, '原话截断到 200 字，别把整页 HTML 塞进错误里');
        assert.ok(!error.message.includes(KEY), '密钥绝不进错误信息');
        return true;
      },
    );
    assert.equal(calls.length, 1, '400 只发一次');
    assert.equal(calls[0].url, `${REMOTE_BASE}/embeddings`);
  } finally {
    restoreFetch();
  }
});

test('HTTP 401：鉴权错误同样不重试（重试改不了密钥），消息里只有状态码', async () => {
  const calls = withFetch(() => reply(401, '{"error":{"message":"Incorrect API key provided"}}'));
  try {
    await assert.rejects(() => rerankWith(cfgOf(), { query: 'q', docs: [DOC] }), /embeddings HTTP 401：/);
    assert.equal(calls.length, 1);
  } finally {
    restoreFetch();
  }
});

test('HTTP 500：重试满 2 次才放弃，消息里明说「已重试 2 次」（不能假装一次就死）', async () => {
  const calls = withFetch(() => reply(500, 'internal error'));
  try {
    await assert.rejects(
      () => rerankWith(cfgOf(), { query: 'q', docs: [DOC] }),
      /embeddings HTTP 500（已重试 2 次）：internal error/,
    );
    assert.equal(calls.length, 3, '首次 + 2 次重试（这一支没有 Retry-After，走的是真指数退避）');
  } finally {
    restoreFetch();
  }
});

test('429 + retry-after 是秒数：按服务端说的等（0 秒即不等），等完重试到上限', async () => {
  const calls = withFetch(() => reply(429, '慢点', { 'retry-after': '0' }));
  try {
    await assert.rejects(() => rerankWith(cfgOf(), { query: 'q', docs: [DOC] }), /HTTP 429（已重试 2 次）/);
    assert.equal(calls.length, 3, 'retry-after: 0 → sleep(0) 直接返回，不退避等待');
  } finally {
    restoreFetch();
  }
});

test('429 + retry-after 是已经过去的 HTTP 日期：等到 0 毫秒就重试，不真等', async () => {
  const past = new Date(Date.now() - 3_600_000).toUTCString();
  const calls = withFetch(() => reply(429, '慢点', { 'retry-after': past }));
  try {
    await assert.rejects(() => rerankWith(cfgOf(), { query: 'q', docs: [DOC] }), /HTTP 429（已重试 2 次）/);
    assert.equal(calls.length, 3, '日期解析成功后 max(0, 过去时刻 - now) = 0，立即重试');
  } finally {
    restoreFetch();
  }
});

test('429 要求等 5 秒时被 abort：重试的睡眠立刻结束，按 signal.reason 抛出，不再补发请求', async () => {
  const calls = withFetch(() => reply(429, '慢点', { 'retry-after': '30' })); // 30s 被钳到 5000ms
  const controller = new AbortController();
  const reason = new Error('接缝的超时预算用完了');
  const timer = setTimeout(() => controller.abort(reason), 0);
  try {
    await assert.rejects(
      () => rerankWith(cfgOf(), { query: 'q', docs: [DOC], signal: controller.signal }),
      (error) => {
        assert.equal(error, reason, '被打断时抛出的就是 signal.reason（接缝靠它区分超时与接口报错）');
        return true;
      },
    );
    assert.equal(calls.length, 1, '睡眠里被打断 → 不会再有第二次请求');
  } finally {
    clearTimeout(timer);
    restoreFetch();
  }
});

test('信号在请求前就已经 abort：睡眠入口发现 aborted 立即中断，不会真睡满 5 秒', async () => {
  // 假 fetch 故意无视 signal（真 fetch 会自己 reject），这样才走得到模块自己的睡眠中断分支
  const calls = withFetch(() => reply(429, '慢点', { 'retry-after': '30' }));
  const controller = new AbortController();
  const reason = new Error('预算在发出请求前就用完了');
  controller.abort(reason);
  try {
    await assert.rejects(
      () => rerankWith(cfgOf(), { query: 'q', docs: [DOC], signal: controller.signal }),
      (error) => {
        assert.equal(error, reason);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  } finally {
    restoreFetch();
  }
});

test('网络层 fetch reject：原样抛给调用方（本模块的纪律就是「失败一律 throw」），不重试', async () => {
  const calls = withFetch(() => {
    throw new TypeError('fetch failed');
  });
  try {
    await assert.rejects(
      () => rerankWith(cfgOf(), { query: 'q', docs: [DOC] }),
      (error) => {
        assert.equal(error.name, 'TypeError');
        assert.match(error.message, /fetch failed/);
        return true;
      },
    );
    assert.equal(calls.length, 1, '连不上不是重试能解决的，不浪费预算');
  } finally {
    restoreFetch();
  }
});

test('fetch 以 AbortError reject（真 fetch 超时/中断的形状）：错误对象原样上抛', async () => {
  const calls = withFetch(() => {
    const error = new Error('This operation was aborted');
    error.name = 'AbortError';
    throw error;
  });
  try {
    await assert.rejects(
      () => rerankWith(cfgOf(), { query: 'q', docs: [DOC] }),
      (error) => {
        assert.equal(error.name, 'AbortError');
        return true;
      },
    );
    assert.equal(calls.length, 1);
  } finally {
    restoreFetch();
  }
});

// ── 响应体解析 ────────────────────────────────────────────────────────────────

test('响应体不是 JSON：抛「不是 JSON」并把开头 120 字带上（便于对着网关日志排查）', async () => {
  const calls = withFetch(() => reply(200, `<html>这不是 JSON ${'y'.repeat(300)}</html>`));
  try {
    await assert.rejects(
      () => rerankWith(cfgOf(), { query: 'q', docs: [DOC] }),
      (error) => {
        assert.match(error.message, /^embeddings 返回的不是 JSON：/);
        assert.ok(error.message.length <= 'embeddings 返回的不是 JSON：'.length + 120, '只带开头 120 字');
        return true;
      },
    );
    assert.equal(calls.length, 1, '200 但不是 JSON 不重试');
  } finally {
    restoreFetch();
  }
});

test('JSON 里缺 data：抛「条数不对：想 2 条，拿到 非数组」（1 篇笔记 + 查询 = 2 段文本）', async () => {
  const calls = withFetch(() => reply(200, '{"object":"list","model":"fake-edge"}'));
  try {
    await assert.rejects(
      () => rerankWith(cfgOf(), { query: 'q', docs: [DOC] }),
      /embeddings 返回的数据条数不对：想 2 条，拿到 非数组/,
    );
    assert.equal(calls.length, 1);
  } finally {
    restoreFetch();
  }
});

test('data 不是数组（对象/字符串/null）：一律按「非数组」拒绝，不去猜', async () => {
  for (const body of ['{"data":{}}', '{"data":"nope"}', '{"data":null}']) {
    const calls = withFetch(() => reply(200, body));
    try {
      await assert.rejects(() => rerankWith(cfgOf(), { query: 'q', docs: [DOC] }), /拿到 非数组/, body);
    } finally {
      restoreFetch();
    }
  }
});

test('data 条数与请求不符：少一条、多一条、空数组都要拦住（宁可失败也不给错序结果）', async () => {
  const row = (index) => ({ embedding: [index, 1], index });
  // 2 篇笔记 + 查询 = 3 段文本；三种坏响应都按「实际请求了几段」来造，避免把条数硬编码错
  const cases = [
    ['少一条', (n) => Array.from({ length: n - 1 }, (_, i) => row(i))],
    ['多一条', (n) => Array.from({ length: n + 1 }, (_, i) => row(i))],
    ['空数组', () => []],
  ];
  for (const [label, rowsOf] of cases) {
    const calls = withFetch((url, init) => {
      const input = init.body ? JSON.parse(init.body).input : [];
      assert.equal(input.length, 3, `${label}：确认这一次请求真的送了 3 段`);
      return reply(200, JSON.stringify({ data: rowsOf(input.length) }));
    });
    try {
      await assert.rejects(
        () => rerankWith(cfgOf(), { query: 'q', docs: [DOC, { id: 'b.md', snippet: '另一篇' }] }),
        /embeddings 返回的数据条数不对：想 3 条，拿到 (2|4|0)/,
        label,
      );
      assert.equal(calls.length, 1, `${label}：条数不对是致命错，不重试`);
    } finally {
      restoreFetch();
    }
  }
});

test('embedding 不是数组 / 是空数组 / 整个缺失：抛「embeddings 返回了空向量」', async () => {
  const bad = ['"[1,2]" 字符串', '[] 空数组', 'undefined 整个缺失'];
  for (const [index, label] of bad.entries()) {
    const calls = withFetch((url, init) => {
      const input = init.body ? JSON.parse(init.body).input : [];
      // 条数是对的（2 段），坏在第一条向量的形状上：先过条数校验，才轮得到向量校验
      return reply(200, JSON.stringify({
        data: input.map((_, i) => (i === 0
          ? { index: 0, embedding: [undefined, [], null][index] }
          : { index: i, embedding: [1, 0] })),
      }));
    });
    try {
      await assert.rejects(() => rerankWith(cfgOf(), { query: 'q', docs: [DOC] }), /embeddings 返回了空向量/, label);
      assert.equal(calls.length, 1, label);
    } finally {
      restoreFetch();
    }
  }
});

test('向量维度不一致：当场抛错点出两个维度（0.13.14 修；此前是 Math.min 静默截断）', async () => {
  // 查询给 2 维、候选给 3 维。过去只有两边都有的那一维参与计算，于是 b.md 与 c.md 的第 3 维
  // 天差地别（0 vs 99）却并列 1 分 —— 这种失真「看起来完全正常」，只有换过模型或缓存里混了
  // 旧向量时才会发生，属于最该响的那种沉默。现在余弦要求等长，并把两个维度写进消息。
  const calls = withFetch((url, init) => {
    const input = init.body ? JSON.parse(init.body).input : [];
    return okRows(input.map((text) => (
      String(text).startsWith('q:') ? [1, 0] : (String(text) === 'c' ? [1, 0, 99] : [1, 0, 0])
    )));
  });
  const cfg = cfgOf({ queryPrefix: 'q:' });
  try {
    await assert.rejects(
      () => rerankWith(cfg, { query: 'q', docs: [{ id: 'b.md', snippet: 'b' }, { id: 'c.md', snippet: 'c' }] }),
      (error) => {
        assert.match(error.message, /向量维度不一致（2 vs 3）/);
        assert.match(error.message, /换了 embedding 模型/, '要给出可能的原因，而不是只报两个数字');
        return true;
      },
    );
    assert.equal(calls.length, 1, '错是在算分那一步发现的：请求本身发得出去（宿主回什么才决定维度）');
  } finally {
    restoreFetch();
  }
});

// ── 空输入：一个请求都不许发 ───────────────────────────────────────────────────

test('空输入：docs 为空数组 / null / 非数组 / 整个参数缺省，都返回 [] 且不发请求', async () => {
  const calls = withFetch(() => {
    throw new Error('这个用例不许发请求');
  });
  try {
    const cfg = cfgOf();
    assert.deepEqual(await rerankWith(cfg, { query: 'q', docs: [] }), []);
    assert.deepEqual(await rerankWith(cfg, { query: 'q', docs: null }), []);
    assert.deepEqual(await rerankWith(cfg, { query: 'q', docs: 'not-an-array' }), []);
    assert.deepEqual(await rerankWith(cfg, { query: 'q' }), []);
    assert.deepEqual(await rerankWith(cfg), []);
    assert.equal(calls.length, 0, '一条候选都没有就不该产生任何 embedding 调用（真金白银）');
  } finally {
    restoreFetch();
  }
});

test('没配密钥的检查在空输入之前：远端端点 + docs 为空也照样抛「没配密钥」', async () => {
  const calls = withFetch(() => {
    throw new Error('这个用例不许发请求');
  });
  try {
    await assert.rejects(
      () => rerankWith(cfgOf({ apiKey: '', local: false }), { query: 'q', docs: [] }),
      /没配密钥/,
      '顺序是：先拦配置错误，再说「没有候选」——否则用户看到空结果会以为配置没问题',
    );
    assert.equal(calls.length, 0);
  } finally {
    restoreFetch();
  }
});

test('纯空白查询：不发明知道会被拒的请求，直接抛「查询是空的」（0.13.14 修）', async () => {
  const calls = withFetch(() => {
    throw new Error('空查询不该发请求');
  });
  try {
    await assert.rejects(
      () => rerankWith(cfgOf(), { query: '   ', docs: [{ id: '', snippet: '  ' }] }),
      /查询是空的/,
    );
    assert.equal(calls.length, 0);
  } finally {
    restoreFetch();
  }
});

test('空文本的笔记被挑出发请求之外：正常笔记照常打分，空的那条留在结果里拿 0 分（0.13.14 修）', async () => {
  // 真 OpenAI 对 input 里的 '' 回 400 —— 一条空笔记能把整批（含正常笔记）一起拖去降级。
  // 现在的口径：空文本不进请求体，但**结果里不少一条**（按 id 稳定排在 0 分那一档）。
  const calls = withFetch((url, init) => {
    const input = init.body ? JSON.parse(init.body).input : [];
    return okRows(input.map((text) => (String(text) === '好笔记' ? [1, 0] : [0, 1])));
  });
  try {
    const ranked = await rerankWith(cfgOf(), {
      query: '好笔记',
      docs: [{ id: 'blank.md', snippet: '   ' }, { id: 'good.md', snippet: '好笔记' }, { id: '', snippet: '' }],
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.input, ['好笔记', '好笔记'], '两条空文本都没进请求体');
    assert.deepEqual(
      ranked.map((doc) => [doc.id, doc.score]),
      [['good.md', 1], ['', 0], ['blank.md', 0]],
      '正常笔记照常 1 分；空文本两条都是 0 分（同分按 id 稳定排序）',
    );
  } finally {
    restoreFetch();
  }
});

// ── 两条默认入口 ──────────────────────────────────────────────────────────────

test('默认入口 rerank()：配置从环境变量读，走完整条链并带上 Bearer 头', async () => {
  const calls = withFetch(() => okRows([[1, 0], [0, 1]]));
  const restore = withEnv(CHECK_ENV);
  try {
    const ranked = await rerank({ query: 'q', docs: [DOC] });
    assert.equal(ranked.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.model, 'fake-edge-check', '模型来自 ENGRAMORY_EMBED_MODEL');
    assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  } finally {
    restore();
    restoreFetch();
  }
});

test('createProvider()：overrides 覆盖配置，并在换 baseUrl 时重算 local（本机端点免密钥那条路）', async () => {
  const calls = withFetch(() => okRows([[1, 0], [1, 0]]));
  const restore = withEnv({ ENGRAMORY_EMBED_CONFIG: NO_CONFIG, ENGRAMORY_EMBED_API_KEY: undefined });
  try {
    const provider = createProvider({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'fake-edge-provider',
      apiKey: '',
      providerName: 'edge-provider',
      batch: 8,
    });
    assert.equal(provider.name, 'edge-provider');
    assert.equal(provider.kind, 'rerank');
    assert.equal(provider.config.local, true, 'baseUrl 换成 127.0.0.1 后 local 必须重算，否则会被「没配密钥」拦下');
    const ranked = await provider.rerank({ query: 'q', docs: [DOC] });
    assert.equal(ranked.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.authorization, undefined, '没有密钥就不该伪造 Authorization 头');

    // 默认名字里带模型名，便于在日志里认出是哪条路由
    const unnamed = createProvider({ baseUrl: REMOTE_BASE, model: 'fake-edge-named', apiKey: KEY });
    assert.equal(unnamed.name, 'openai-embeddings(fake-edge-named)');
  } finally {
    restore();
    restoreFetch();
  }
});

// ── 说明：两条曾经「只钉现状」的隐患，0.13.14 已修 ──────────────────────────
//
// 1) 向量维度一致性（见「向量维度不一致」用例）：
//    过去 `cosine()` 用 `Math.min(a.length, b.length)` —— 维度不同就**静默按短的那条算**，
//    查询 [1,0] 对候选 [1,0,99] 与 [1,0,0] 都是 1.0 分（99 那一维被喂了狗）。现在维度不等直接抛，
//    消息里带上两个维度与最可能的原因（换过模型 / 缓存里混着旧向量）。
//
// 2) 空文本（见「纯空白查询」「空文本的笔记」两条用例）：
//    纯空白 query 过去原样送出（真 OpenAI 回 400）；snippet/title/id 都空、又没配 docPrefix 的笔记
//    会送出一个 ''，一条空笔记就能把整批（含正常笔记）拖去降级。现在：空查询当场抛、不发请求；
//    空文本的笔记不进请求体，但结果里不少一条、拿 0 分。
//
// 3) 覆盖率口径（不是 bug，是 Node 的行为，决定本文件的写法）：
//    `--test --experimental-test-coverage` 按**文件路径**归并，同路径多个脚本实例时**后加载的整份覆盖先加载的**。
//    因此 `openai-embeddings.mjs:351`（「打印用法」那一行）注定点不亮：它要求 `isMain && !--check`，
//    而同一份实例一旦满足这个条件就永远走不到 353-366。该行由「打印用法」用例断言，只是不进覆盖率报告。
