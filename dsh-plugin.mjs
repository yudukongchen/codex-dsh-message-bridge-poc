import net from 'node:net';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PHASES, createRequest, awaitBound } from './request-state.mjs';
import { PROTOCOL_VERSION, MAX_REQUEST_BYTES, MAX_CONNECTIONS, publishEndpoint, removeOwnEndpoint } from './transport.mjs';

export const name = 'codex-dsh-message-bridge-poc';
export const version = '0.3.1';
export const inject = ['sessionController'];
export const endpointFile = join(homedir(), '.dsh', 'bridge-poc', 'endpoint.json');

// Protocol-level rejections carry { error } to the client; request-level failures
// always resolve to the unified { requestId, sessionId, status, reply, errorCode } shape.
const protocolError = code => Object.assign(new Error(code), { protocol: true });
const STRUCTURAL = new Set(['reply-timeout', 'dsh-create-failed', 'dsh-prompt-failed', 'attribution-conflict', 'turn-conflict', 'event-malformed', 'internal-error', 'bridge-stopped', 'client-disconnected', 'cancel-failed']);
// DSH emits these host-generated context records as user/message too. They
// carry no rpcId and must neither admit a request nor look like manual input.
const HOST_CONTEXT_SOURCES = new Set(['agent-instructions', 'runtime-context', 'skill-catalog', 'time-context']);
// A private session isolates test traffic from sessions already open in the UI.
export async function startBridge(ctx, config = {}) {
  const stateFile = config.stateFile ?? endpointFile;
  const pipe = config.pipe ?? `\\\\.\\pipe\\codex-dsh-poc-${randomUUID()}`;
  const token = randomBytes(32).toString('hex');
  const timeoutMs = config.timeoutMs ?? 120_000;
  const timeZone = config.timezone ?? 'Asia/Shanghai';
  let sessionId;
  let lastSessionId;
  let active;
  let recovery;
  const sockets = new Set();

  // Isolate the session behind a failed request: the next send must start fresh
  // so a late DSH outcome can never be attributed to a newer request.
  const isolate = (req, code) => {
    if (active !== req || req.settled) return;
    recovery = { requestId: req.id, sessionId: req.sessionId, reason: code, taskRunning: req.sessionId !== null };
    req.hostAbort?.abort();
    req.fail(code);
    sessionId = undefined;
  };

  function handleEvent(session, event) {
    const req = active;
    if (!req || req.settled || session.id !== req.sessionId) return;
    const type = typeof event?.type === 'string' ? event.type : undefined;
    const data = event?.data;
    if (!type || data === null || typeof data !== 'object') {
      if (type) isolate(req, 'event-malformed');
      return;
    }
    if (type === 'turn/start') {
      if (typeof data.turn !== 'number') { isolate(req, 'event-malformed'); return; }
      if (req.turn === undefined) { if (req.admitted) req.turn = data.turn; }
      else if (req.turn !== data.turn) { isolate(req, 'turn-conflict'); return; }
      req.currentTurn = data.turn;
      return;
    }
    if (type === 'user/message') {
      if (HOST_CONTEXT_SOURCES.has(data.source?.kind)) return;
      if (data?.source?.rpcId === req.id) {
        req.admitted = true;
        if (req.turn === undefined && req.currentTurn !== undefined) req.turn = req.currentTurn;
        if (req.phase === PHASES.creatingSession || req.phase === PHASES.awaitingAdmission) req.phase = PHASES.awaitingCompletion;
        return;
      }
      // Any other user message on the bridged session (manual insertion) breaks attribution.
      isolate(req, 'attribution-conflict');
      return;
    }
    if (req.turn === undefined || data?.turn !== req.turn) return;
    if (type === 'assistant/message') {
      const content = data.message?.content;
      if (!Array.isArray(content)) { isolate(req, 'event-malformed'); return; }
      req.recordText(data.step, content.filter(x => x?.type === 'text').map(x => x.text ?? '').join('\n'));
    }
    if (type === 'turn/end') {
      const kind = typeof data.reason?.kind === 'string' ? data.reason.kind : 'unknown';
      const reply = req.finalReply();
      const result = { requestId: req.id, sessionId: req.sessionId, status: kind === 'completed' && !reply ? 'empty-reply' : kind, reply };
      const code = data.reason?.error?.code;
      if (typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code)) result.errorCode = code;
      req.settle(result);
    }
  }

  // Global callback runs on the host's dispatch stack: nothing may escape it.
  const disposeEvent = ctx.on('session/event', (session, event) => {
    try { handleEvent(session, event); }
    catch { if (active && !active.settled) isolate(active, 'internal-error'); }
  }, { global: true });

  async function handleSend(text) {
    if (active && !active.settled) throw protocolError('busy');
    // A new request supersedes the previous recovery marker; the ping phase reports idle again.
    recovery = undefined;
    const req = createRequest({
      timeoutMs,
      onExpire: r => {
        if (active !== r) return;
        recovery = { requestId: r.id, sessionId: r.sessionId, reason: 'reply-timeout', taskRunning: r.sessionId !== null };
        sessionId = undefined;
      },
    });
    req.hostAbort = new AbortController();
    active = req;
    try {
      if (!sessionId) {
        const created = await awaitBound(req, ctx.sessionController.create({ cwd: config.cwd }), 'dsh-create-failed');
        if (created.result) return created.result;
        sessionId = created.value.sessionId;
        req.phase = PHASES.awaitingAdmission;
      } else {
        req.phase = PHASES.awaitingAdmission;
      }
      lastSessionId = sessionId;
      req.sessionId = sessionId;
      const delivered = await awaitBound(req, ctx.sessionController.prompt({ sessionId, requestId: req.id, content: [{ type: 'text', text }], clientTimeZone: timeZone }, req.hostAbort.signal), 'dsh-prompt-failed');
      if (delivered.result) return delivered.result;
      return await req.completion;
    } catch (error) {
      // Structural failures keep the unified shape; a request that died before
      // any session existed uses empty values.
      if (error?.protocol) throw error;
      const code = STRUCTURAL.has(error?.message) ? error.message : 'dsh-prompt-failed';
      isolate(req, code);
      return { requestId: req.id ?? null, sessionId: req.sessionId ?? null, status: 'failed', reply: '', errorCode: code };
    } finally {
      if (active === req) active = undefined;
      // Abort only an abandoned caller-side wait; a normally completed turn must not
      // send a cancel into DSH, and the timeout policy is "stop waiting, not cancel".
      if (!req.settled || req.result === null) req.hostAbort?.abort();
    }
  }

  async function handleCancel() {
    const req = active && !active.settled ? active : undefined;
    if (req && req.sessionId === null) {
      // No prompt has been submitted yet. Settle this request so a late create
      // result cannot admit it, and never fall back to a historical session.
      req.hostAbort?.abort();
      const result = { requestId: req.id, sessionId: null, status: 'aborted', reply: '' };
      req.settle(result);
      return result;
    }
    const target = req ? req.sessionId : (recovery?.sessionId ?? sessionId);
    if (!target) return { requestId: null, sessionId: null, status: 'failed', reply: '', errorCode: 'no-session' };
    try {
      await ctx.sessionController.cancel({ sessionId: target });
    } catch { return { requestId: req?.id ?? null, sessionId: target, status: 'failed', reply: '', errorCode: 'cancel-failed' }; }
    // Confirmation alone is not completion: when a request is in flight, report its final end state.
    if (req) {
      try { return await req.completion; }
      catch (error) { return { requestId: req.id, sessionId: req.sessionId ?? target, status: 'failed', reply: '', errorCode: STRUCTURAL.has(error?.message) ? error.message : 'cancel-failed' }; }
    }
    return { requestId: null, sessionId: target, status: 'cancel-requested', reply: '' };
  }

  function handleRequest(request) {
    if (request.action === 'ping') {
      return { status: 'ready', protocol: PROTOCOL_VERSION, pluginVersion: version, sessionId: sessionId ?? null, phase: active && !active.settled ? active.phase : (recovery ? PHASES.awaitingRecovery : PHASES.idle), timeoutMs, timezone: timeZone, recovery: recovery ?? null };
    }
    if (request.action === 'new-session') {
      if (active && !active.settled) throw protocolError('busy');
      const previous = sessionId ?? lastSessionId ?? null;
      // History stays in DSH; the next send creates a fresh session. Running tasks are not cancelled.
      sessionId = undefined;
      recovery = undefined;
      return { status: 'ready', previousSessionId: previous, sessionId: null };
    }
    if (request.action === 'cancel') return handleCancel();
    if (request.action !== 'send') throw protocolError('unknown-action');
    if (typeof request.text !== 'string' || !request.text.trim() || request.text.length > 16_000) throw protocolError('invalid-request');
    return handleSend(request.text);
  }

  const server = net.createServer(socket => {
    if (sockets.size >= MAX_CONNECTIONS) {
      // Never fail silently: an over-limit client must get a fixed error frame.
      socket.end(JSON.stringify({ error: 'too-many-clients' }) + '\n');
      socket.destroy();
      return;
    }
    socket.setEncoding('utf8');
    sockets.add(socket);
    let request;
    socket.on('close', () => {
      sockets.delete(socket);
      // Client gone: release local waiting state; the DSH task keeps running and is recorded.
      const req = request;
      if (req && !req.settled && active === req) {
        recovery = { requestId: req.id, sessionId: req.sessionId ?? null, reason: 'client-disconnected', taskRunning: true };
        sessionId = undefined;
        req.fail('client-disconnected');
      }
    });
    socket.on('error', () => {});
    socket.setTimeout(130_000, () => socket.destroy());
    let input = '';
    let handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BYTES) { handled = true; socket.end(JSON.stringify({ error: 'message-too-large' }) + '\n'); return; }
      if (!input.includes('\n')) return;
      handled = true;
      (async () => {
        let parsed;
        try { parsed = JSON.parse(input.slice(0, input.indexOf('\n'))); }
        catch { throw protocolError('invalid-json'); }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw protocolError('invalid-json');
        const supplied = Buffer.from(typeof parsed.token === 'string' ? parsed.token : '');
        const expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw protocolError('unauthorized');
        const before = active;
        const outcome = handleRequest(parsed);
        // Bind only the request this very socket created, so a busy- or
        // cancel-client disconnect never frees someone else's request.
        if (parsed.action === 'send' && active !== before) request = active;
        return outcome;
      })().then(result => { if (!socket.destroyed) socket.end(JSON.stringify(result) + '\n'); },
        error => { if (!socket.destroyed) socket.end(JSON.stringify(error?.protocol ? { error: error.message } : { error: 'internal-error' }) + '\n'); });
    });
  });
  // No server.maxConnections: the manual quota above replies with a fixed error frame
  // before destroying, which the built-in limit (silent destroy) cannot do.

  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  } catch (error) { disposeEvent(); throw error; }
  try {
    await publishEndpoint(stateFile, { pipe, token, pid: process.pid });
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    disposeEvent();
    await new Promise(resolve => server.close(resolve));
    throw error;
  }

  return async () => {
    if (active && !active.settled) { active.hostAbort?.abort(); active.fail('bridge-stopped'); }
    disposeEvent();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    // Only remove the endpoint file this instance published.
    await removeOwnEndpoint(stateFile, pipe);
  };
}

export async function apply(ctx, config) {
  const stop = await startBridge(ctx, config);
  ctx.on('dispose', stop);
}
