// Offline, same-user mailboxes. Immutable files and atomic hard links let
// independent CLI processes publish/retry without a daemon or stale locks.
import { mkdir, open, link, rm, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectPrivateAcl } from './windows-acl.mjs';

export const inboxRoot = join(homedir(), '.dsh', 'bridge-poc', 'inbox');
const MAX_TEXT = 16_000;
const MAX_FILE = 100_000; // Includes JSON escaping of a 16 KB body.
const ID = /^[a-f0-9]{64}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CHANNEL = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const fail = (code, hint) => { const error = new Error(code); if (hint) error.hint = hint; throw error; };
// Unsafe and unverifiable permissions both block writes, but only the first is
// an ACL verdict; the second must not be reported as one.
export function aclFailure(acl) {
  if (acl.reason === 'acl-unsafe') return ['inbox-insecure-acl', '收件箱目录允许当前用户、管理员和系统之外的访问，请先运行 install.ps1 保护状态目录。'];
  return ['inbox-acl-unverified', `无法验证收件箱目录权限：${acl.detail ?? '未知原因'}。命令拒绝在未验证的目录保存消息。`];
}
const peer = side => side === 'codex' ? 'dsh' : 'codex';
function validate(side, channel) {
  if (!['codex', 'dsh'].includes(side)) fail('inbox-invalid-side');
  // Canonical names also prevent case/trailing-dot aliases on Windows.
  if (typeof channel !== 'string' || !CHANNEL.test(channel) || DEVICE.test(channel)) fail('inbox-invalid-channel');
}
const hash = value => createHash('sha256').update(value).digest('hex');

async function readJson(file) {
  const handle = await open(file, 'r');
  try {
    if ((await handle.stat()).size > MAX_FILE) fail('inbox-corrupt');
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error.code) throw error;
    fail('inbox-corrupt');
  } finally { await handle.close(); }
}

async function publish(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally { await handle.close(); }
    await link(temp, file); // Atomic create-if-absent; never overwrite a winner.
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally { await rm(temp, { force: true }); }
}

export async function openInbox(root = inboxRoot, inspectAcl = inspectPrivateAcl) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  // The installer protects the parent on Windows. Refuse to store messages in
  // an unprotected directory rather than silently accepting broad permissions;
  // an unverifiable directory is refused for the same reason.
  if (process.platform === 'win32') {
    const acl = await inspectAcl(root);
    if (!acl.ok) fail(...aclFailure(acl));
  }
  async function directory(side, channel) {
    validate(side, channel);
    const dir = join(root, channel, side);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  async function message(dir, id, side, channel) {
    if (!ID.test(id)) fail('inbox-invalid-id');
    const item = await readJson(join(dir, `${id}.json`));
    if (!item || typeof item !== 'object' || item.version !== 1 || item.id !== id || item.to !== side || item.from !== peer(side) || item.channel !== channel ||
        item.authority !== 'agent-message' || typeof item.text !== 'string' || !item.text.trim() ||
        Buffer.byteLength(item.text) > MAX_TEXT || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) ||
        typeof item.key !== 'string' || !LABEL.test(item.key) ||
        hash(JSON.stringify([item.from, channel, item.key])) !== id ||
        !(item.replyTo === null || (typeof item.replyTo === 'string' && ID.test(item.replyTo)))) fail('inbox-corrupt');
    return item;
  }
  return {
    async post({ side, channel, text, key = randomUUID(), replyTo = null }) {
      validate(side, channel);
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_TEXT) fail('inbox-invalid-text');
      if (typeof key !== 'string' || !LABEL.test(key)) fail('inbox-invalid-key');
      if (replyTo !== null) {
        const own = await directory(side, channel);
        try { await message(own, replyTo, side, channel); }
        catch (error) { if (error.code === 'ENOENT') fail('inbox-reply-not-found'); throw error; }
      }
      const to = peer(side);
      const dir = await directory(to, channel);
      const id = hash(JSON.stringify([side, channel, key]));
      const item = { version: 1, id, key, channel, from: side, to, authority: 'agent-message', text, replyTo, createdAt: new Date().toISOString() };
      const inserted = await publish(join(dir, `${id}.json`), item);
      const stored = inserted ? item : await message(dir, id, to, channel);
      if (stored.text !== text || stored.replyTo !== replyTo) fail('inbox-key-conflict');
      return { status: 'queued', duplicate: !inserted, message: stored };
    },
    async read({ side, channel, limit = 20 }) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) fail('inbox-invalid-limit');
      const dir = await directory(side, channel);
      const files = await readdir(dir);
      const acknowledged = new Set(files.filter(f => /^[a-f0-9]{64}\.ack$/.test(f)).map(f => f.slice(0, -4)));
      const unread = [];
      for (const file of files.filter(f => /^[a-f0-9]{64}\.json$/.test(f))) {
        const id = file.slice(0, -5);
        if (!acknowledged.has(id)) unread.push(await message(dir, id, side, channel));
      }
      unread.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      return { status: 'ready', side, channel, unread: unread.length, hasMore: unread.length > limit, messages: unread.slice(0, limit) };
    },
    async ack({ side, channel, id }) {
      const dir = await directory(side, channel);
      try { await message(dir, id, side, channel); }
      catch (error) { if (error.code === 'ENOENT') fail('inbox-message-not-found'); throw error; }
      const inserted = await publish(join(dir, `${id}.ack`), { acknowledgedAt: new Date().toISOString() });
      return { status: 'acknowledged', id, duplicate: !inserted };
    },
  };
}

export async function waitInbox(store, options, waitMs = 30_000, signal) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000) fail('inbox-invalid-wait');
  const until = Date.now() + waitMs;
  for (;;) {
    signal?.throwIfAborted();
    const result = await store.read(options);
    if (result.unread || Date.now() >= until) return { ...result, timedOut: result.unread === 0 };
    await delay(Math.min(250, until - Date.now()), undefined, { signal });
  }
}

export async function inboxCommand(argv, readStdin, root = inboxRoot) {
  const [action, ...args] = argv;
  const options = { side: 'codex' };
  const text = [];
  const seen = new Set();
  const flags = { '--as': 'side', '--channel': 'channel', '--id': 'key', '--reply-to': 'replyTo', '--limit': 'limit', '--wait-ms': 'waitMs' };
  let stdin = false;
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!literal && arg === '--') { literal = true; continue; }
    if (!literal && arg.startsWith('--')) {
      if (seen.has(arg)) fail('inbox-invalid-options');
      seen.add(arg);
      if (arg === '--stdin') { stdin = true; continue; }
      const field = flags[arg];
      if (!field || !args[i + 1] || args[i + 1].startsWith('--')) fail('inbox-invalid-options');
      options[field] = ['limit', 'waitMs'].includes(field) ? Number(args[++i]) : args[++i];
    } else text.push(arg);
  }
  const allowed = {
    post: ['--as', '--channel', '--id', '--reply-to', '--stdin'],
    read: ['--as', '--channel', '--limit'],
    ack: ['--as', '--channel', '--id'],
    watch: ['--as', '--channel', '--limit', '--wait-ms'],
  };
  if (!allowed[action] || [...seen].some(flag => !allowed[action].includes(flag)) ||
      (action !== 'post' && text.length) || (stdin && text.length)) fail('inbox-invalid-options');
  validate(options.side, options.channel);
  const store = await openInbox(root);
  if (action === 'post') return store.post({ ...options, text: stdin ? await readStdin() : text.join(' ') });
  if (action === 'ack') return store.ack({ ...options, id: options.key ?? '' });
  if (action === 'watch') return waitInbox(store, options, options.waitMs);
  return store.read(options);
}
