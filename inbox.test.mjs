import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openInbox, inboxCommand, waitInbox } from './inbox.mjs';

const run = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-inbox-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  if (process.platform === 'win32') {
    const script = `$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; & icacls.exe $env:INBOX_TEST_ROOT /inheritance:r /grant:r "*\${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null; if ($LASTEXITCODE -ne 0) { exit 1 }`;
    await run('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, INBOX_TEST_ROOT: root }, windowsHide: true });
  }
  return { root, store: await openInbox(root) };
}
const codex = { side: 'codex', channel: 'test' };
const dsh = { side: 'dsh', channel: 'test' };

test('offline bidirectional delivery survives reopen; reading never acknowledges', async t => {
  const { store, root } = await fixture(t);
  const sent = await store.post({ ...dsh, text: 'DSH 主动留言\n第二行' });
  assert.equal((await store.read(codex)).messages[0].id, sent.message.id);
  const reopened = await openInbox(root);
  assert.equal((await reopened.read(codex)).unread, 1);
  const reply = await reopened.post({ ...codex, text: '已收到', replyTo: sent.message.id });
  assert.equal(reply.message.authority, 'agent-message');
  assert.equal(reply.message.from, 'codex');
  assert.equal((await store.read(dsh)).messages[0].replyTo, sent.message.id);
  await store.ack({ ...codex, id: sent.message.id });
  assert.equal((await reopened.read(codex)).unread, 0);
  assert.equal((await store.ack({ ...codex, id: sent.message.id })).duplicate, true);
  assert.equal((await reopened.read(dsh)).unread, 1);
});

test('same id retries deduplicate even after acknowledgement; changed content conflicts', async t => {
  const { store } = await fixture(t);
  const item = { ...dsh, text: 'hello', key: 'stable-1' };
  const first = await store.post(item);
  await store.ack({ ...codex, id: first.message.id });
  assert.equal((await store.post(item)).duplicate, true);
  assert.equal((await store.read(codex)).unread, 0);
  await assert.rejects(store.post({ ...item, text: 'changed' }), /inbox-key-conflict/);
});

test('parallel processes publish one winner without lost messages or partial JSON', async t => {
  const { root, store } = await fixture(t);
  const script = `import {openInbox} from ${JSON.stringify(new URL('./inbox.mjs', import.meta.url).href)}; const store=await openInbox(process.env.INBOX_TEST_ROOT); console.log(JSON.stringify(await store.post({side:'dsh',channel:'test',key:'same-key',text:'concurrent'})));`;
  const results = await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, INBOX_TEST_ROOT: root }, windowsHide: true })));
  assert.equal(results.map(r => JSON.parse(r.stdout)).filter(r => !r.duplicate).length, 1);
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.post({ ...dsh, key: `m-${i}`, text: `${i}` })));
  const page = await store.read({ ...codex, limit: 5 });
  assert.equal(page.unread, 21);
  assert.equal(page.messages.length, 5);
  assert.equal(page.hasMore, true);
  assert.equal((await readdir(join(root, 'test', 'codex'))).some(f => f.endsWith('.tmp')), false);
});

test('channel and recipient isolation prevent cross acknowledgements and replies', async t => {
  const { store } = await fixture(t);
  const { message } = await store.post({ ...dsh, text: 'one channel' });
  assert.equal((await store.read({ ...codex, channel: 'other' })).unread, 0);
  await assert.rejects(store.ack({ ...dsh, id: message.id }), /inbox-message-not-found/);
  await assert.rejects(store.ack({ ...codex, channel: 'other', id: message.id }), /inbox-message-not-found/);
  await assert.rejects(store.post({ ...dsh, text: 'wrong direction', replyTo: message.id }), /inbox-reply-not-found/);
});

test('unread pages drain through explicit ack without losing queued messages', async t => {
  const { store } = await fixture(t);
  for (let i = 0; i < 7; i++) await store.post({ ...dsh, text: `message ${i}` });
  const ids = new Set();
  while (true) {
    const page = await store.read({ ...codex, limit: 2 });
    if (!page.unread) break;
    for (const item of page.messages) { ids.add(item.id); await store.ack({ ...codex, id: item.id }); }
  }
  assert.equal(ids.size, 7);
});

test('watch observes later offline delivery and has a bounded timeout and abort', async t => {
  const { store } = await fixture(t);
  const waiting = waitInbox(store, codex, 2000);
  await store.post({ ...dsh, text: 'wake active reader' });
  assert.equal((await waiting).timedOut, false);
  const empty = { ...codex, channel: 'empty' };
  assert.equal((await waitInbox(store, empty, 20)).timedOut, true);
  const abort = new AbortController();
  const pending = waitInbox(store, empty, 2000, abort.signal);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal((await store.read(codex)).unread, 1);
});

test('input validation rejects traversal, invalid sides, ids and UTF-8 overflows', async t => {
  const { store } = await fixture(t);
  for (const channel of ['../escape', '..', '/abs', 'x/y', '', 'Test', 'test.', 'con', 'nul', 'com1']) {
    await assert.rejects(store.read({ ...codex, channel }), /inbox-invalid-channel/);
  }
  await assert.rejects(store.read({ ...codex, side: 'user' }), /inbox-invalid-side/);
  await assert.rejects(store.ack({ ...codex, id: '../x' }), /inbox-invalid-id/);
  await assert.rejects(store.post({ ...dsh, text: '中'.repeat(5334) }), /inbox-invalid-text/);
  await assert.rejects(store.post({ ...dsh, text: '  ' }), /inbox-invalid-text/);
  await assert.rejects(store.read({ ...codex, limit: 21 }), /inbox-invalid-limit/);
  await assert.rejects(waitInbox(store, codex, 60001), /inbox-invalid-wait/);
});

test('escaped text roundtrips at the byte limit; interrupted temp files stay invisible', async t => {
  const { store, root } = await fixture(t);
  const text = 'x' + '\u0000'.repeat(15999);
  await store.post({ ...dsh, text });
  await writeFile(join(root, 'test', 'codex', 'interrupted.tmp'), '{');
  assert.equal((await store.read(codex)).messages[0].text, text);
});

test('corrupt published messages fail explicitly instead of silently dropping unread mail', async t => {
  const { store, root } = await fixture(t);
  const { message } = await store.post({ ...dsh, text: 'keep' });
  await writeFile(join(root, 'test', 'codex', `${message.id}.json`), '{');
  await assert.rejects(store.read(codex), /inbox-corrupt/);
});

test('CLI parser supports stdin and explicit roles, validates flags before storing', async t => {
  const { root } = await fixture(t);
  const invoke = args => inboxCommand(args, async () => '多行\n$(literal) `text`', root);
  const sent = await invoke(['post', '--as', 'dsh', '--channel', 'cli', '--id', 'retry', '--stdin']);
  assert.equal(sent.message.text, '多行\n$(literal) `text`');
  const read = await invoke(['read', '--channel', 'cli']);
  assert.equal(read.messages[0].id, sent.message.id);
  assert.equal((await invoke(['ack', '--channel', 'cli', '--id', sent.message.id])).status, 'acknowledged');
  for (const args of [ ['read'], ['post', '--channel', 'cli', '--unknown'], ['read', '--channel', 'cli', '--stdin'], ['post', '--channel', 'cli', '--stdin', 'extra'], ['ack', '--channel', 'cli'], ['watch', '--channel', 'cli', '--wait-ms', 'NaN'] ]) {
    await assert.rejects(invoke(args), /inbox-/);
  }
});

test('Windows inbox refuses a directory that grants other users access', { skip: process.platform !== 'win32' }, async t => {
  const { root } = await fixture(t);
  await run('icacls.exe', [root, '/grant', '*S-1-1-0:(OI)(CI)R'], { windowsHide: true });
  await assert.rejects(openInbox(root), /inbox-insecure-acl/);
});

test('an unverifiable ACL probe refuses storage with a distinct code', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-inbox-unverified-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const probe = acl => async () => acl;
  // A blocked probe must not masquerade as a permissions verdict.
  await assert.rejects(openInbox(root, probe({ ok: false, reason: 'probe-unavailable', detail: 'spawn EPERM，可能被沙箱拦截' })),
    error => error.message === 'inbox-acl-unverified' && /spawn EPERM/.test(error.hint));
  await assert.rejects(openInbox(root, probe({ ok: false, reason: 'acl-unsafe', detail: 'x' })),
    error => error.message === 'inbox-insecure-acl' && /install\.ps1/.test(error.hint));
  const store = await openInbox(root, probe({ ok: true, reason: 'ok', detail: 'ok' }));
  assert.equal((await store.post({ ...dsh, text: 'ok' })).status, 'queued');
});
