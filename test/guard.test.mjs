/**
 * 写入闸门的单测。每条都能对着 AGENTS.md 的写入纪律讲出「为什么拒」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMemoryWrite, parseFrontmatter, scanSecrets, MAX_NOTE_BYTES } from '../guard.js';

const STORE = '/tmp/memory-store';
const at = (name) => `${STORE}/${name}`;
const fm = (extra = '') => `---\nname: reference-demo\ndescription: 演示笔记\n${extra}---\n\n# 正文\n`;

test('闸门：合法笔记放行', () => {
  assert.deepEqual(checkMemoryWrite({ filePath: at('reference-demo.md'), storePath: STORE, content: fm() }), {
    ok: true,
  });
});

test('闸门：库外路径、索引、未配置都放行', () => {
  assert.equal(checkMemoryWrite({ filePath: '/tmp/elsewhere/note.md', storePath: STORE, content: 'x' }).ok, true);
  assert.equal(checkMemoryWrite({ filePath: at('MEMORY.md'), storePath: STORE, content: 'x' }).ok, true);
  assert.equal(checkMemoryWrite({ filePath: at('reference-demo.md'), storePath: '', content: 'x' }).ok, true);
});

test('闸门：文件名不合规就拒', () => {
  for (const bad of [
    'notes.md',
    'reference_demo.md',
    'Reference-demo.md',
    'reference-Demo.md',
    'misc-demo.md',
    'reference-.md',
  ]) {
    const verdict = checkMemoryWrite({ filePath: at(bad), storePath: STORE, content: fm() });
    assert.equal(verdict.ok, false, bad);
    assert.match(verdict.reason, /文件名/);
  }
});

test('闸门：frontmatter 必须齐 name / description，且 type 与前缀一致', () => {
  const noFm = checkMemoryWrite({ filePath: at('reference-demo.md'), storePath: STORE, content: '# 没有头部\n' });
  assert.equal(noFm.ok, false);
  assert.match(noFm.reason, /frontmatter/);

  const noName = checkMemoryWrite({
    filePath: at('reference-demo.md'),
    storePath: STORE,
    content: '---\ndescription: x\n---\n',
  });
  assert.equal(noName.ok, false);
  assert.match(noName.reason, /name/);

  const noDesc = checkMemoryWrite({
    filePath: at('reference-demo.md'),
    storePath: STORE,
    content: '---\nname: x\n---\n',
  });
  assert.equal(noDesc.ok, false);
  assert.match(noDesc.reason, /description/);

  const mismatch = checkMemoryWrite({
    filePath: at('reference-demo.md'),
    storePath: STORE,
    content: '---\nname: x\ndescription: y\ntype: project\n---\n',
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /type/);

  const matched = checkMemoryWrite({
    filePath: at('reference-demo.md'),
    storePath: STORE,
    content: '---\nname: x\ndescription: y\ntype: reference\n---\n',
  });
  assert.deepEqual(matched, { ok: true });
});

test('闸门：真实凭据一律拒（fail-closed）', () => {
  const cases = [
    ['OpenAI', 'sk-abcdefghijklmnopqrstuvwx'],
    ['GitHub', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
    ['AWS', 'AKIAIOSFODNN7EXAMPLE'],
    ['私钥', '-----BEGIN RSA PRIVATE KEY-----'],
    ['键值对', 'password: hunter2hunter2hunter2'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop'],
  ];
  for (const [label, blob] of cases) {
    const verdict = checkMemoryWrite({
      filePath: at('reference-demo.md'),
      storePath: STORE,
      content: `${fm()}\n凭据：${blob}\n`,
    });
    assert.equal(verdict.ok, false, label);
    assert.match(verdict.reason, /凭据/);
  }
});

test('闸门：只记「密钥在哪里」必须放行', () => {
  const allowed = [
    'apiKey = process.env.OPENAI_API_KEY',
    'access_token: <YOUR_TOKEN>',
    'secret = ***',
    'password: CHANGEME',
    'token 在 ~/.dsh/secrets.yml 里，不进记忆库',
  ];
  for (const blob of allowed) {
    const verdict = checkMemoryWrite({
      filePath: at('reference-demo.md'),
      storePath: STORE,
      content: `${fm()}\n${blob}\n`,
    });
    assert.deepEqual(verdict, { ok: true }, blob);
  }
});

test('闸门：超长笔记拒收（一条一主题）', () => {
  const huge = fm() + 'x'.repeat(MAX_NOTE_BYTES + 1024);
  const verdict = checkMemoryWrite({ filePath: at('reference-demo.md'), storePath: STORE, content: huge });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /单篇上限/);
});

test('闸门：edit 片段只查文件名与凭据', () => {
  assert.deepEqual(checkMemoryWrite({ filePath: at('reference-demo.md'), storePath: STORE, fragment: '补一行普通说明' }), {
    ok: true,
    partial: true,
  });
  assert.equal(
    checkMemoryWrite({ filePath: at('reference-demo.md'), storePath: STORE, fragment: 'token = sk-abcdefghijklmnopqrst' }).ok,
    false,
  );
  assert.equal(checkMemoryWrite({ filePath: at('notes.md'), storePath: STORE, fragment: 'x' }).ok, false);
});

test('parseFrontmatter 认得真实头部，也认得没有头部', () => {
  const parsed = parseFrontmatter(
    '---\nname: reference-x\ndescription: 说明\ntype: reference\nscope: global\ncreated: 2026-10-14\n---\n\n# 标题\n',
  );
  assert.equal(parsed.fields.name, 'reference-x');
  assert.equal(parsed.fields.type, 'reference');
  assert.equal(parsed.fields.scope, 'global');
  assert.equal(parseFrontmatter('# 无头部'), undefined);
  assert.equal(parseFrontmatter('---\nname: x\n--- 末尾还有字\n'), undefined);
});

test('scanSecrets 直测', () => {
  assert.equal(scanSecrets('一切正常，没有钥匙'), undefined);
  assert.equal(scanSecrets('sk-abcdefghijklmnopqrst'), 'OpenAI 风格密钥');
  assert.match(scanSecrets('access_token = "abcdefghijklmnop1234"'), /access_token/);
  assert.match(scanSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop'), /JWT/);
});
