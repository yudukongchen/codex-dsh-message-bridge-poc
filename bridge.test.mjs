import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startBridge } from './dsh-plugin.mjs';
import { requestBridge } from './bridge.mjs';
import { PROTOCOL_VERSION, connectErrorCode, readFramedReply } from './transport.mjs';

// Fake host: prompt()/create()/cancel() behaviour and event emission are scripted per test.
async function fixture(t, host = {}, timeoutMs = 1000) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-test-'));
  const stateFile = join(dir, 'endpoint.json');
  let listener;
  const emit = (type, data, id = 'test-session') => listener({ id }, { type, data });
  const ctx = {
    on: (_, callback) => { listener = callback; return () => {}; },
    sessionController: {
      create: host.create ?? (async () => ({ sessionId: 'test-session' })),
      prompt: host.prompt ?? (async () => { throw new Error('unused'); }),
      cancel: host.cancel ?? (async () => { throw new Error('session/not-found'); }),
    },
  };
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-test-${randomUUID()}` : join(dir, 'ipc.sock');
  const stop = await startBridge(ctx, { stateFile, pipe, timeoutMs });
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  return { stateFile, emit, dir, pipe, stop };
}

// Raw single-frame exchange, bypassing requestBridge, for protocol-level assertions.
// The socket is destroyed after the frame: leaving it half-open would leak server
// connections and trip the connection limit for later requests.
function rawExchange(stateFile, raw) {
  return (async () => {
    const endpoint = JSON.parse(await readFile(stateFile, 'utf8'));
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(endpoint.pipe);
      socket.setEncoding('utf8');
      let data = '';
      socket.on('error', reject);
      socket.on('connect', () => socket.write(raw));
      socket.on('data', chunk => { data += chunk; if (data.includes('\n')) { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } socket.destroy(); } });
    });
  })();
}

test('IPC roundtrip ignores other sessions and waits for turn/end', async t => {
  const f = await fixture(t, { prompt: async req => {
    f.emit('turn/start', { turn: 7 });
    f.emit('user/message', { source: { rpcId: req.requestId } });
    f.emit('assistant/message', { turn: 7, message: { content: [{ type: 'text', text: 'wrong' }] } }, 'other-session');
    f.emit('assistant/message', { turn: 7, message: { content: [{ type: 'text', text: '执行完成，请检查' }] } });
    setTimeout(() => f.emit('turn/end', { turn: 7, reason: { kind: 'completed' } }), 20);
    return { accepted: true };
  } });
  const ping = await requestBridge('ping', undefined, f.stateFile);
  assert.equal(ping.status, 'ready');
  assert.equal(ping.protocol, PROTOCOL_VERSION);
  assert.equal(ping.phase, 'idle');
  assert.equal(typeof ping.pluginVersion, 'string');
  assert.equal('token' in ping, false);
  const result = await requestBridge('send', '按文档执行', f.stateFile);
  assert.equal(result.reply, '执行完成，请检查');
  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, 'test-session');
});

test('host-injected context messages do not break user request attribution', async t => {
  const f = await fixture(t, { prompt: async req => {
    f.emit('turn/start', { turn: 1 });
    f.emit('user/message', { source: { kind: 'user', rpcId: req.requestId } });
    for (const kind of ['agent-instructions', 'runtime-context', 'skill-catalog', 'time-context']) {
      f.emit('user/message', { source: { kind }, content: [{ type: 'text', text: 'host context' }] });
    }
    f.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'context accepted' }] } });
    f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
    return { accepted: true };
  } });
  const result = await requestBridge('send', 'test', f.stateFile);
  assert.equal(result.status, 'completed');
  assert.equal(result.reply, 'context accepted');
});

test('accepted alone does not count as a response; timeout isolates and reports recovery', async t => {
  const f = await fixture(t, { prompt: async () => ({ accepted: true }) }, 40);
  const result = await requestBridge('send', 'test', f.stateFile);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'reply-timeout');
  const ping = await requestBridge('ping', undefined, f.stateFile);
  assert.equal(ping.phase, 'awaiting-recovery');
  assert.equal(ping.recovery.reason, 'reply-timeout');
  assert.equal(ping.recovery.taskRunning, true);
  assert.equal(ping.sessionId, null);
});

test('host context alone cannot admit a request or attribute a reply', async t => {
  const f = await fixture(t, { prompt: async () => {
    f.emit('turn/start', { turn: 1 });
    f.emit('user/message', { source: { kind: 'runtime-context' } });
    f.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'unattributed' }] } });
    f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
    return { accepted: true };
  } }, 40);
  const result = await requestBridge('send', 'test', f.stateFile);
  assert.equal(result.errorCode, 'reply-timeout');
  assert.equal(result.reply, '');
});

for (const source of [{ kind: 'user', rpcId: 'another-request' }, { kind: 'unknown-context' }]) {
  test(`non-host message still rejects attribution: ${source.kind}`, async t => {
    const f = await fixture(t, { prompt: async req => {
      f.emit('turn/start', { turn: 1 });
      f.emit('user/message', { source: { kind: 'user', rpcId: req.requestId } });
      f.emit('user/message', { source });
      return { accepted: true };
    } });
    const result = await requestBridge('send', 'test', f.stateFile);
    assert.equal(result.errorCode, 'attribution-conflict');
  });
}

test('hanging create still answers within the deadline', async t => {
  const f = await fixture(t, { create: () => new Promise(() => {}) }, 40);
  const result = await requestBridge('send', 'test', f.stateFile);
  assert.equal(result.status, 'failed');
  assert.ok(['reply-timeout', 'dsh-create-failed'].includes(result.errorCode), result.errorCode);
});

test('hanging prompt still answers within the deadline', async t => {
  const f = await fixture(t, { prompt: () => new Promise(() => {}) }, 40);
  const result = await requestBridge('send', 'test', f.stateFile);
  assert.equal(result.status, 'failed');
  assert.ok(['reply-timeout', 'dsh-prompt-failed'].includes(result.errorCode), result.errorCode);
});

test('a timed-out request discards late host outcomes and the next send starts fresh', async t => {
  let lateResolve;
  let firstRequest;
  let secondRequest;
  let created = 0;
  let secondStarted;
  const started = new Promise(resolve => { secondStarted = resolve; });
  const f = await fixture(t, {
    create: async () => ({ sessionId: `timeout-session-${++created}` }),
    prompt: request => {
      if (!firstRequest) {
        firstRequest = request;
        return new Promise(resolve => { lateResolve = resolve; });
      }
      secondRequest = request;
      secondStarted();
      return Promise.resolve({ accepted: true });
    },
  }, 200);
  const first = await requestBridge('send', 'first', f.stateFile);
  assert.equal(first.errorCode, 'reply-timeout');
  const sending = requestBridge('send', 'second', f.stateFile);
  await started;
  lateResolve({ accepted: true });
  f.emit('turn/start', { turn: 1 }, firstRequest.sessionId);
  f.emit('user/message', { source: { rpcId: firstRequest.requestId } }, firstRequest.sessionId);
  f.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'late old reply' }] } }, firstRequest.sessionId);
  f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, firstRequest.sessionId);
  const waiting = await requestBridge('ping', undefined, f.stateFile);
  assert.equal(waiting.phase, 'awaiting-admission');
  f.emit('turn/start', { turn: 1 }, secondRequest.sessionId);
  f.emit('user/message', { source: { rpcId: secondRequest.requestId } }, secondRequest.sessionId);
  f.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'new reply' }] } }, secondRequest.sessionId);
  f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, secondRequest.sessionId);
  const result = await sending;
  assert.equal(result.status, 'completed');
  assert.equal(result.reply, 'new reply');
  assert.notEqual(result.sessionId, first.sessionId);
  assert.equal(created, 2);
  const ping = await requestBridge('ping', undefined, f.stateFile);
  assert.equal(ping.recovery, null);
  assert.equal(ping.phase, 'idle');
});

test('admission failure is surfaced in the unified shape without leaking host errors', async t => {
  const f = await fixture(t, { prompt: async () => { throw new Error('private host detail'); } });
  const result = await requestBridge('send', 'test', f.stateFile);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'dsh-prompt-failed');
  assert.equal(JSON.stringify(result).includes('private host detail'), false);
});

test('failed admission cannot expire later or invalidate the next successful session', async t => {
  let created = 0;
  let prompts = 0;
  const f = await fixture(t, {
    create: async () => ({ sessionId: `session-${++created}` }),
    prompt: async req => {
      if (++prompts === 1) throw new Error('simulated admission failure');
      f.emit('turn/start', { turn: 1 }, req.sessionId);
      f.emit('user/message', { source: { rpcId: req.requestId } }, req.sessionId);
      f.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'recovered' }] } }, req.sessionId);
      f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, req.sessionId);
      return { accepted: true };
    },
  }, 150);
  assert.equal((await requestBridge('send', 'first', f.stateFile)).errorCode, 'dsh-prompt-failed');
  const second = await requestBridge('send', 'second', f.stateFile);
  assert.equal(second.status, 'completed');
  await new Promise(r => setTimeout(r, 220));
  const ping = await requestBridge('ping', undefined, f.stateFile);
  assert.equal(ping.phase, 'idle');
  assert.equal(ping.recovery, null);
  assert.equal(ping.sessionId, second.sessionId);
  assert.equal(created, 2, 'a failed admission must isolate its session');
});

test('failed creation clears its deadline before the next request', async t => {
  const f = await fixture(t, { create: async () => { throw new Error('simulated creation failure'); } }, 80);
  assert.equal((await requestBridge('send', 'first', f.stateFile)).errorCode, 'dsh-create-failed');
  const before = await requestBridge('ping', undefined, f.stateFile);
  await new Promise(r => setTimeout(r, 120));
  const after = await requestBridge('ping', undefined, f.stateFile);
  assert.deepEqual(after.recovery, before.recovery);
  assert.equal(after.phase, before.phase);
});

test('unauthenticated local clients cannot prompt DSH', async t => {
  let called = false;
  const f = await fixture(t, { prompt: () => { called = true; } });
  const reply = await rawExchange(f.stateFile, JSON.stringify({ action: 'send', text: 'test', token: 'wrong' }) + '\n');
  assert.equal(reply.error, 'unauthorized');
  assert.equal(called, false);
});

test('model error is not reported as completed; sessions can be reset with history info', async t => {
  const f = await fixture(t, { prompt: async req => {
    f.emit('turn/start', { turn: 1 });
    f.emit('user/message', { source: { rpcId: req.requestId } });
    setTimeout(() => f.emit('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'REQUEST_EXTENSION', message: 'private' } } }), 10);
    return { accepted: true };
  } });
  const result = await requestBridge('send', 'test', f.stateFile);
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, 'REQUEST_EXTENSION');
  assert.equal(JSON.stringify(result).includes('private'), false);
  const reset = await requestBridge('new-session', undefined, f.stateFile);
  assert.equal(reset.previousSessionId, 'test-session');
  const ping = await requestBridge('ping', undefined, f.stateFile);
  assert.equal(ping.sessionId, null);
});

test('normal end without text reports empty-reply instead of completed', async t => {
  const f = await fixture(t, { prompt: async req => {
    f.emit('turn/start', { turn: 3 });
    f.emit('user/message', { source: { rpcId: req.requestId } });
    setTimeout(() => f.emit('turn/end', { turn: 3, reason: { kind: 'completed' } }), 10);
    return { accepted: true };
  } });
  const result = await requestBridge('send', 'test', f.stateFile);
  assert.equal(result.status, 'empty-reply');
  assert.equal(result.reply, '');
});

test('manual message insertion reports conflict and isolates the session', async t => {
  const f = await fixture(t, { prompt: async req => {
    f.emit('turn/start', { turn: 1 });
    f.emit('user/message', { source: { rpcId: req.requestId } });
    setTimeout(() => f.emit('user/message', { content: [{ type: 'text', text: '1' }] }), 10);
    return { accepted: true };
  } });
  const result = await requestBridge('send', 'test', f.stateFile);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'attribution-conflict');
  const ping = await requestBridge('ping', undefined, f.stateFile);
  assert.equal(ping.sessionId, null);
});

test('malformed events fail the request with a diagnosis and never throw into the host', async t => {
  const f = await fixture(t, { prompt: async req => {
    f.emit('turn/start', { turn: 1 });
    f.emit('user/message', { source: { rpcId: req.requestId } });
    setTimeout(() => f.emit('assistant/message', undefined), 10); // missing data
    return { accepted: true };
  } });
  const result = await requestBridge('send', 'test', f.stateFile);
  assert.equal(result.errorCode, 'event-malformed');
  // Unknown event types with valid payloads are harmless.
  const f2 = await fixture(t, { prompt: async req => {
    f2.emit('turn/start', { turn: 1 });
    f2.emit('user/message', { source: { rpcId: req.requestId } });
    f2.emit('nonsense/type', { turn: 1 });
    setTimeout(() => f2.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }), 10);
    return { accepted: true };
  } });
  assert.equal((await requestBridge('send', 'test', f2.stateFile)).status, 'empty-reply');
});

test('duplicate turn/end and post-settle events have no side effects', async t => {
  const f = await fixture(t, { prompt: async req => {
    f.emit('turn/start', { turn: 2 });
    f.emit('user/message', { source: { rpcId: req.requestId } });
    f.emit('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'A' }] } });
    f.emit('turn/end', { turn: 2, reason: { kind: 'completed' } });
    f.emit('turn/end', { turn: 2, reason: { kind: 'completed' } });
    f.emit('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'B' }] } });
    return { accepted: true };
  } });
  const result = await requestBridge('send', 'test', f.stateFile);
  assert.equal(result.status, 'completed');
  assert.equal(result.reply, 'A');
});

test('multi-step assistant messages: last step text wins, no duplication', async t => {
  const f = await fixture(t, { prompt: async req => {
    f.emit('turn/start', { turn: 4 });
    f.emit('user/message', { source: { rpcId: req.requestId } });
    f.emit('assistant/message', { turn: 4, step: 0, message: { content: [{ type: 'text', text: '中间步骤' }] } });
    f.emit('assistant/message', { turn: 4, step: 1, message: { content: [{ type: 'text', text: '最终回复' }] } });
    setTimeout(() => f.emit('turn/end', { turn: 4, reason: { kind: 'completed' } }), 10);
    return { accepted: true };
  } });
  const result = await requestBridge('send', 'test', f.stateFile);
  assert.equal(result.reply, '最终回复');
});

test('stale endpoint file reports a clear diagnosis, not a raw connect error', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-stale-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'endpoint.json');
  await writeFile(stateFile, JSON.stringify({ version: PROTOCOL_VERSION, pipe: `\\\\.\\pipe\\does-not-exist-${randomUUID()}`, token: 'x'.repeat(32), pid: 1 }));
  await assert.rejects(requestBridge('ping', undefined, stateFile, 5_000), error => {
    assert.equal(error.bridgeResult.errorCode, 'endpoint-stale');
    assert.ok(error.message.includes('扩展'));
    return true;
  });
});

test('malformed endpoint contents map to distinct error codes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-bad-ep-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'endpoint.json');
  await assert.rejects(requestBridge('ping', undefined, stateFile, 5_000), /扩展尚未加载/);
  await writeFile(stateFile, JSON.stringify({ version: 99, pipe: 'x', token: 'y'.repeat(32) }));
  await assert.rejects(requestBridge('ping', undefined, stateFile, 5_000), error => error.bridgeResult.errorCode === 'endpoint-version');
  await writeFile(stateFile, JSON.stringify({ version: PROTOCOL_VERSION, pipe: 'x' }));
  await assert.rejects(requestBridge('ping', undefined, stateFile, 5_000), /连接文件内容不完整/);
});

test('illegal JSON and null bodies get fixed protocol errors without stacks', async t => {
  const f = await fixture(t);
  const endpoint = JSON.parse(await readFile(f.stateFile, 'utf8'));
  assert.equal((await rawExchange(f.stateFile, 'not json\n')).error, 'invalid-json');
  assert.equal((await rawExchange(f.stateFile, 'null\n')).error, 'invalid-json');
  assert.equal((await rawExchange(f.stateFile, JSON.stringify({ token: endpoint.token, action: 'nope' }) + '\n')).error, 'unknown-action');
  assert.equal((await rawExchange(f.stateFile, JSON.stringify({ token: endpoint.token, action: 'send', text: '  ' }) + '\n')).error, 'invalid-request');
  assert.equal((await rawExchange(f.stateFile, JSON.stringify({ token: endpoint.token, action: 'send', text: 'x'.repeat(17_000) }) + '\n')).error, 'invalid-request');
  const big = 'x'.repeat(70_000);
  assert.equal((await rawExchange(f.stateFile, JSON.stringify({ token: endpoint.token, action: 'send', text: big }) + '\n')).error, 'message-too-large');
});

test('oversized client input is framed by the server even in one write', async t => {
  const f = await fixture(t);
  const reply = await rawExchange(f.stateFile, JSON.stringify({ action: 'send', text: 'z'.repeat(66_000), token: JSON.parse(await readFile(f.stateFile, 'utf8')).token }) + '\n');
  assert.equal(reply.error, 'message-too-large');
});

test('startup rollback: an unwriteable endpoint path leaves no listening resources', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-rollback-'));
  const blocker = join(dir, 'blocker.txt');
  await writeFile(blocker, 'x'); // a *file* where the state directory must be: mkdir fails with ENOTDIR
  const ctx = { on: () => () => {}, sessionController: {} };
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-test-${randomUUID()}` : join(dir, 'ipc.sock');
  await assert.rejects(startBridge(ctx, { stateFile: join(blocker, 'endpoint.json'), pipe, timeoutMs: 10 }), /ENOTDIR|EEXIST|EPERM|EACCES/);
  // The pipe must not stay open after the failed publish.
  const connectFailed = await new Promise(resolve => {
    const socket = net.createConnection(pipe);
    socket.on('connect', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(true));
    setTimeout(() => resolve(false), 1_000);
  });
  assert.equal(connectFailed, true);
  await rm(dir, { recursive: true, force: true });
});

test('instance replacement: disposing an old bridge keeps the new endpoint file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bridge-replace-'));
  const stateFile = join(dir, 'endpoint.json');
  const mk = async () => {
    const ctx = { on: () => () => {}, sessionController: {} };
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-test-${randomUUID()}` : join(dir, `ipc-${randomUUID()}.sock`);
    return { stop: await startBridge(ctx, { stateFile, pipe, timeoutMs: 10 }), pipe };
  };
  const first = await mk();
  const second = await mk();
  await first.stop(); // old instance exits after the new one published
  const kept = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(kept.pipe, second.pipe);
  await second.stop();
  await assert.rejects(readFile(stateFile, 'utf8'), /ENOENT/);
  await rm(dir, { recursive: true, force: true });
});

test('busy is rejected while a request is in flight', async t => {
  const f = await fixture(t, { prompt: () => new Promise(() => {}) }, 5_000);
  // Attach the outcome handler immediately: stop() below rejects this request,
  // and a late-attached assert.rejects would surface it as unhandled.
  const settled = requestBridge('send', 'test', f.stateFile).then(result => ({ result }), error => ({ error }));
  await new Promise(r => setTimeout(r, 30));
  const reply = await rawExchange(f.stateFile, JSON.stringify({ action: 'send', text: 'again', token: JSON.parse(await readFile(f.stateFile, 'utf8')).token }) + '\n');
  assert.equal(reply.error, 'busy');
  const ping = await requestBridge('ping', undefined, f.stateFile);
  assert.equal(ping.phase, 'awaiting-admission');
  assert.equal(ping.recovery, null);
  // Stop frees the in-flight request; its client socket sees no usable reply and fails.
  await f.stop();
  const outcome = await settled;
  assert.ok(outcome.error, JSON.stringify(outcome));
});

test('connection limit rejects extra clients with a fixed error', async t => {
  const f = await fixture(t);
  const endpoint = JSON.parse(await readFile(f.stateFile, 'utf8'));
  const openIdle = () => new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint.pipe);
    socket.on('error', reject);
    socket.on('connect', () => resolve(socket)); // connect only: stays open unhandled
  });
  const held = [];
  for (let i = 0; i < 4; i++) held.push(await openIdle());
  const rejected = await new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint.pipe);
    held.push(socket);
    let data = '';
    socket.on('error', reject);
    socket.on('data', chunk => { data += chunk; if (data.includes('\n')) resolve(JSON.parse(data)); });
    setTimeout(() => resolve({ error: 'no-frame' }), 2_000);
  });
  assert.equal(rejected.error, 'too-many-clients');
  for (const socket of held) socket.destroy();
});

test('client disconnect releases the waiting slot and records the running task', async t => {
  const f = await fixture(t, { prompt: () => new Promise(() => {}) }, 5_000);
  const endpoint = JSON.parse(await readFile(f.stateFile, 'utf8'));
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint.pipe);
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({ action: 'send', text: 'test', token: endpoint.token }) + '\n'));
    setTimeout(() => { socket.destroy(); resolve(); }, 60);
  });
  await new Promise(r => setTimeout(r, 60));
  const ping = await requestBridge('ping', undefined, f.stateFile);
  assert.equal(ping.phase, 'awaiting-recovery');
  assert.equal(ping.recovery.reason, 'client-disconnected');
  assert.equal(ping.recovery.taskRunning, true);
});

test('cancel without a session fails cleanly; cancel of a running request reports its end state', async t => {
  const f = await fixture(t);
  const noSession = await requestBridge('cancel', undefined, f.stateFile);
  assert.equal(noSession.status, 'failed');
  assert.equal(noSession.errorCode, 'no-session');

  const f2 = await fixture(t, {
    prompt: async req => { f2.emit('turn/start', { turn: 9 }); f2.emit('user/message', { source: { rpcId: req.requestId } }); return { accepted: true }; },
    cancel: async () => { setTimeout(() => f2.emit('turn/end', { turn: 9, reason: { kind: 'aborted', cause: { kind: 'user' } } }), 10); return { accepted: true }; },
  }, 5_000);
  const inflight = requestBridge('send', 'test', f2.stateFile);
  await new Promise(r => setTimeout(r, 40));
  const cancelled = await requestBridge('cancel', undefined, f2.stateFile);
  assert.equal(cancelled.status, 'aborted');
  assert.equal(cancelled.sessionId, 'test-session');
  assert.equal((await inflight).status, 'aborted');
});

test('cancel during creation aborts only the new request and prevents late prompt admission', async t => {
  let created = 0;
  let finishCreation;
  let creationStarted;
  const started = new Promise(resolve => { creationStarted = resolve; });
  const cancelled = [];
  const prompted = [];
  const f = await fixture(t, {
    create: () => {
      if (++created === 1) return Promise.resolve({ sessionId: 'old-session' });
      creationStarted();
      return new Promise(resolve => { finishCreation = resolve; });
    },
    prompt: async req => {
      prompted.push(req.sessionId);
      f.emit('turn/start', { turn: 1 }, req.sessionId);
      f.emit('user/message', { source: { rpcId: req.requestId } }, req.sessionId);
      f.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'done' }] } }, req.sessionId);
      f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, req.sessionId);
      return { accepted: true };
    },
    cancel: async req => { cancelled.push(req.sessionId); return { accepted: true }; },
  }, 500);
  await requestBridge('send', 'old', f.stateFile);
  await requestBridge('new-session', undefined, f.stateFile);
  assert.equal((await requestBridge('cancel', undefined, f.stateFile)).errorCode, 'no-session');
  const sending = requestBridge('send', 'new', f.stateFile);
  await started;
  const result = await requestBridge('cancel', undefined, f.stateFile);
  finishCreation({ sessionId: 'new-session' });
  assert.equal(result.status, 'aborted');
  assert.equal(result.sessionId, null);
  assert.equal((await sending).requestId, result.requestId);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(cancelled, []);
  assert.deepEqual(prompted, ['old-session']);
  assert.equal((await requestBridge('ping', undefined, f.stateFile)).sessionId, null);
});

test('cancel returns the final state even when the host ends the turn before acknowledging', async t => {
  let admitted;
  const started = new Promise(resolve => { admitted = resolve; });
  const f = await fixture(t, {
    prompt: async req => {
      f.emit('turn/start', { turn: 1 });
      f.emit('user/message', { source: { rpcId: req.requestId } });
      admitted();
      return { accepted: true };
    },
    cancel: async () => {
      f.emit('turn/end', { turn: 1, reason: { kind: 'aborted' } });
      return { accepted: true };
    },
  });
  const sending = requestBridge('send', 'test', f.stateFile);
  await started;
  const cancelled = await requestBridge('cancel', undefined, f.stateFile);
  assert.equal(cancelled.status, 'aborted');
  assert.equal((await sending).requestId, cancelled.requestId);
});

test('connectErrorCode maps transport failures', () => {
  assert.equal(connectErrorCode({ code: 'ENOENT' }), 'endpoint-stale');
  assert.equal(connectErrorCode({ code: 'ECONNREFUSED' }), 'endpoint-refused');
  assert.equal(connectErrorCode({ code: 'UNKNOWN' }), 'connect-failed');
});

test('readFramedReply bounds oversized replies', async t => {
  const server = net.createServer(socket => {
    socket.on('error', () => {}); // the client destroys mid-write; reset noise is expected
    try { socket.write('x'.repeat(2_000_000)); } catch { /* closed early */ }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const socket = net.createConnection(server.address().port, '127.0.0.1');
  socket.on('error', () => {});
  await assert.rejects(readFramedReply(socket, code => new Error(code)), /reply-too-large/);
  socket.destroy();
  await new Promise(r => server.close(r));
});
