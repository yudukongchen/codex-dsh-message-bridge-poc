// Central request lifecycle for the bridge. The pipe only carries bytes and
// DSH events only advance the current request; all state transitions live here.
import { randomUUID } from 'node:crypto';

export const PHASES = Object.freeze({
  idle: 'idle',
  creatingSession: 'creating-session',
  awaitingAdmission: 'awaiting-admission',
  awaitingCompletion: 'awaiting-completion',
  awaitingRecovery: 'awaiting-recovery',
});

// One request object owns its settle/cleanup; a settled request never changes again.
export function createRequest({ timeoutMs, onExpire }) {
  let resolve;
  let reject;
  const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Admission may still be awaiting I/O when the reply timer expires.
  completion.catch(() => {});
  const req = {
    id: randomUUID(),
    phase: PHASES.creatingSession,
    sessionId: null,
    admitted: false,
    currentTurn: undefined,
    turn: undefined,
    texts: new Map(),
    diagnostics: [],
    settled: false,
    expired: false,
    result: null,
    hostAbort: null,
    completion,
  };
  req.settle = result => {
    if (req.settled) return false;
    req.settled = true;
    clearTimeout(req.timer);
    req.result = result;
    resolve(result);
    return true;
  };
  req.fail = code => {
    if (req.settled) return false;
    req.settled = true;
    clearTimeout(req.timer);
    reject(new Error(code));
    return true;
  };
  req.timer = setTimeout(() => {
    if (req.settled) return;
    req.expired = true;
    req.phase = PHASES.awaitingRecovery;
    req.fail('reply-timeout');
    onExpire?.(req);
  }, timeoutMs);
  req.recordText = (step, text) => { req.texts.set(step ?? req.texts.size, text); };
  // Multiple assistant/message events can land in one turn (one per step);
  // the last one carries the final text, so never concatenate or overwrite earlier ones blindly.
  req.finalReply = () => { let reply = ''; for (const text of req.texts.values()) reply = text; return reply; };
  return req;
}

// Bound a host call by the request deadline: a hanging create/prompt must not
// delay the timeout answer. A late host outcome is discarded, never re-attached
// to newer request state.
export async function awaitBound(req, promise, failCode) {
  const winner = await Promise.race([
    promise.then(value => ({ kind: 'value', value }), () => ({ kind: 'host-error' })),
    req.completion.then(result => ({ kind: 'result', result }), error => ({ kind: 'failed', error })),
  ]);
  if (winner.kind === 'value') return { value: winner.value };
  if (winner.kind === 'result') return { result: winner.result };
  if (winner.kind === 'failed') throw winner.error;
  throw new Error(failCode);
}
