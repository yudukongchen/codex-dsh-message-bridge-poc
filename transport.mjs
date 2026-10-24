// Transport helpers: endpoint-file publishing/validation and line-framed I/O.
// Kept separate from the plugin body so startup cleanup and client-side error
// mapping can be tested without a DSH host.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const PROTOCOL_VERSION = 2;
export const MAX_REQUEST_BYTES = 65_536;
export const MAX_REPLY_BYTES = 1_048_576;
export const MAX_CONNECTIONS = 4;

// Map a low-level connect failure to a diagnosis the caller can act on.
// PID liveness is only advisory; the real availability check is the pipe handshake.
export function connectErrorCode(error) {
  const code = error?.code ?? '';
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') return 'endpoint-stale';
  if (code === 'ECONNREFUSED') return 'endpoint-refused';
  return 'connect-failed';
}

export function connectErrorMessage(errorCode) {
  if (errorCode === 'endpoint-stale') return 'DSH 扩展尚未加载或已停止（连接文件残留），请确认扩展已安装并重启 DSH。';
  if (errorCode === 'endpoint-refused') return 'DSH 扩展的本地管道拒绝连接，请重启 DSH 后重试。';
  if (errorCode === 'unauthorized') return '连接令牌无效，请重启 DSH 重新生成连接文件。';
  if (errorCode === 'reply-too-large') return 'DSH 回复超过大小限制。';
  if (errorCode === 'reply-malformed') return 'DSH 扩展返回了无法解析的回复。';
  if (errorCode === 'no-reply') return 'DSH 扩展未返回回复，请重启 DSH 后重试。';
  return '无法连接 DSH 扩展，请确认 DSH 已启动且扩展已加载。';
}

// Publish endpoint info via a temp file + rename so readers never see a partial JSON.
export async function publishEndpoint(stateFile, info) {
  await mkdir(dirname(stateFile), { recursive: true });
  // Stage inside the protected directory so credentials never enter a broader
  // temp directory and the final file inherits the intended Windows ACL.
  const tmp = join(dirname(stateFile), `.bridge-poc-endpoint-${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify({ ...info, version: PROTOCOL_VERSION }), { mode: 0o600, flag: 'wx' });
    await rename(tmp, stateFile);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function readEndpoint(stateFile) {
  let raw;
  try { raw = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch { throw new Error('endpoint-not-loaded'); }
  if (raw.version !== PROTOCOL_VERSION) throw new Error('endpoint-version');
  if (typeof raw.pipe !== 'string' || !raw.pipe || typeof raw.token !== 'string' || raw.token.length < 16) throw new Error('endpoint-malformed');
  return raw;
}

export async function removeOwnEndpoint(stateFile, pipeName) {
  // Only remove when the file still belongs to this instance, so an old
  // instance exiting never deletes a newer instance's endpoint.
  try {
    const current = JSON.parse(await readFile(stateFile, 'utf8'));
    if (current.pipe === pipeName) await rm(stateFile, { force: true });
  } catch { /* already gone or unreadable: leave it alone */ }
}

// Collect a newline-framed JSON reply, bounded by MAX_REPLY_BYTES.
export function readFramedReply(socket, rejectWith) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_REPLY_BYTES) {
        socket.destroy();
        reject(rejectWith('reply-too-large'));
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      let parsed;
      try { parsed = JSON.parse(buffer.slice(0, end)); }
      catch { socket.destroy(); reject(rejectWith('reply-malformed')); return; }
      resolve(parsed);
    });
    socket.on('error', error => reject(rejectWith(connectErrorCode(error), error)));
    socket.on('close', () => {
      if (!buffer.includes('\n')) reject(rejectWith('no-reply'));
    });
  });
}
