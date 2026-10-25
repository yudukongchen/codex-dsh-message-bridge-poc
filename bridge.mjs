import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as bridgePlugin from './dsh-plugin.mjs';
import { PROTOCOL_VERSION, MAX_REQUEST_BYTES, connectErrorMessage, readEndpoint, readFramedReply } from './transport.mjs';
import { readPluginManifest } from './manifest.mjs';
import { inspectPrivateAcl } from './windows-acl.mjs';
import { inboxCommand } from './inbox.mjs';

const endpointFile = bridgePlugin.endpointFile;
// The manifest URL install.ps1 writes into the profile, for the doctor's comparison.
const pluginFile = join(dirname(fileURLToPath(import.meta.url)), 'dsh-plugin.mjs');

const CLIENT_MARGIN_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 125_000;
const readJsonOrNull = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };

function clientTimeout() {
  const raw = process.env.DSH_BRIDGE_TIMEOUT_MS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1_000 ? parsed : DEFAULT_TIMEOUT_MS;
}

// Unified client failure: same shape as a server result, exit code 1.
export function bridgeError(errorCode, message) {
  const error = new Error(message ?? errorCode);
  error.bridgeResult = { requestId: null, sessionId: null, status: 'failed', reply: '', errorCode, ...(message ? { message } : {}) };
  return error;
}

export async function requestBridge(action, text, stateFile = endpointFile, waitMs = clientTimeout()) {
  const endpoint = await readEndpoint(stateFile).catch(error => {
    const code = error.message;
    if (code === 'endpoint-not-loaded') throw bridgeError(code, 'DSH 扩展尚未加载，请安装扩展并重启 DSH 后重试。');
    if (code === 'endpoint-version') throw bridgeError(code, '连接文件协议版本与本客户端不一致，请更新扩展并重启 DSH。');
    if (code === 'endpoint-malformed') throw bridgeError(code, '连接文件内容不完整，请重启 DSH 重新生成。');
    throw bridgeError('endpoint-malformed', error.message);
  });
  const payload = { action, token: endpoint.token };
  if (text !== undefined) {
    if (Buffer.byteLength(text, 'utf8') > 16_000) throw bridgeError('message-too-large', '消息超过 16000 字符限制。');
    payload.text = text;
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint.pipe);
    socket.setTimeout(waitMs + CLIENT_MARGIN_MS, () => { socket.destroy(); reject(bridgeError('reply-timeout', '等待 DSH 回复超时：本轮任务可能仍在 DSH 中运行。')); });
    socket.once('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    readFramedReply(socket, (code, cause) => bridgeError(code, connectErrorMessage(code, cause)))
      .then(result => { socket.destroy(); if (result.error) reject(bridgeError(result.error, connectErrorMessage(result.error))); else resolve({ ...result, protocol: endpoint.version ?? PROTOCOL_VERSION }); }, reject);
  });
}

async function readStdin() {
  process.stdin.setEncoding('utf8');
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
    size += Buffer.byteLength(chunk, 'utf8');
    if (size > MAX_REQUEST_BYTES) throw bridgeError('message-too-large', '标准输入超过大小限制。');
  }
  return chunks.join('');
}

export async function doctor({ stateFile = endpointFile, profileFile = join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), manifestFile = pluginFile } = {}) {
  const checks = [];
  const push = (item, ok, detail) => checks.push({ item, ok, detail });
  let manifest = null;
  try {
    manifest = await readPluginManifest(manifestFile);
    push('manifest-name', true, `package/module name=${manifest.name}`);
    push('manifest-version', true, `package/module version=${manifest.version}`);
  } catch (error) {
    push('manifest-name', false, '无法确认包元数据与模块导出一致');
    push('manifest-version', false, error.message);
  }

  const profileDir = dirname(profileFile);
  const packageName = manifest?.name ?? 'codex-dsh-message-bridge-poc';
  let profileText = null;
  try { profileText = await readFile(profileFile, 'utf8'); } catch { /* missing */ }
  if (profileText === null) push('profile-entry', false, `未找到配置文件 ${profileFile}`);
  else {
    const begins = (profileText.match(/^# BEGIN codex-dsh-message-bridge-poc$/gm) ?? []).length;
    const ends = (profileText.match(/^# END codex-dsh-message-bridge-poc$/gm) ?? []).length;
    const entryOk = (begins === 1 && ends === 1);
    push('profile-entry', entryOk, begins === 0 ? '未发现扩展配置块，请先运行 install.ps1' : `BEGIN=${begins} END=${ends}`);
    if (entryOk) {
      const block = profileText.match(/^# BEGIN codex-dsh-message-bridge-poc[\s\S]*?^# END codex-dsh-message-bridge-poc/m);
      const named = block?.[0]?.match(/^\s*name:\s*'((?:[^']|'')*)'/m)?.[1]?.replace(/''/g, "'");
      const legacy = typeof named === 'string' && named.toLowerCase().startsWith('file:');
      push('profile-points-here', named === packageName && !legacy,
        legacy ? `旧版 file:// 条目（${named}），请迁移为包名` : `profile 条目：${named ?? '无法解析'}`);
    }
  }

  // The plugin is mounted by the profile package: dependency, bundles and
  // node_modules must all line up or the entry silently does nothing.
  const profilePackage = await readJsonOrNull(join(profileDir, 'package.json'));
  const dependency = profilePackage?.dependencies?.[packageName];
  push('package-dependency', typeof dependency === 'string', dependency ? `dependencies: ${dependency}` : `dependencies 中缺少 ${packageName}`);
  const bundles = profilePackage?.dsh?.profile?.bundles;
  const bundled = Array.isArray(bundles) && bundles.includes(packageName);
  push('package-bundled', bundled, bundled ? 'dsh.profile.bundles 已包含包名' : `dsh.profile.bundles 中缺少 ${packageName}，请用客户端 shim 安装`);
  const installed = await readJsonOrNull(join(profileDir, 'node_modules', packageName, 'package.json'));
  const installedOk = typeof installed?.version === 'string' && installed.version === manifest?.version;
  push('package-installed', installedOk, installed?.version ? `node_modules 版本 ${installed.version}，仓库版本 ${manifest?.version ?? '未知'}` : `node_modules 中未找到 ${packageName}`);
  const directoryAcl = await inspectPrivateAcl(dirname(stateFile));
  push('state-dir-acl', directoryAcl.ok, directoryAcl.detail);
  const endpointAcl = await inspectPrivateAcl(stateFile);
  push('endpoint-file-acl', endpointAcl.ok, endpointAcl.detail);

  let endpoint = null;
  try { endpoint = await readEndpoint(stateFile); push('endpoint-file', true, `协议版本 ${endpoint.version}`); }
  catch (error) { push('endpoint-file', false, error.message); }
  if (endpoint) {
    push('endpoint-pid-advisory', typeof endpoint.pid === 'number', `pid=${endpoint.pid}（仅供参考，以管道握手为准）`);
    try {
      const reply = await requestBridge('ping', undefined, stateFile, 10_000);
      push('pipe-handshake', reply.status === 'ready', `status=${reply.status} phase=${reply.phase} plugin=${reply.pluginVersion}`);
    } catch (error) { push('pipe-handshake', false, error.bridgeResult?.errorCode ?? error.message); }
  }
  return { ok: checks.every(c => c.ok), checks };
}

async function main(argv) {
  if (argv[0] === 'inbox') {
    try { console.log(JSON.stringify(await inboxCommand(argv.slice(1), readStdin), null, 2)); }
    catch (error) {
      const code = /^inbox-[a-z-]+$/.test(error.message) ? error.message : 'inbox-storage-error';
      console.error(JSON.stringify({ status: 'failed', errorCode: code, ...(error.hint ? { hint: error.hint } : {}) }));
      process.exitCode = 1;
    }
    return;
  }
  const flags = [];
  const positional = [];
  for (const arg of argv) (arg.startsWith('--') ? flags : positional).push(arg);
  const [action = 'ping', ...rest] = positional;
  let text = rest.join(' ');
  if (action === 'send' && (text === '-' || flags.includes('--stdin'))) text = (await readStdin()).trim();
  if (action === 'doctor') {
    const report = await doctor();
    for (const c of report.checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.item}: ${c.detail}`);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  try {
    const result = await requestBridge(action, text || undefined);
    const { protocol, ...payload } = result;
    console.log(JSON.stringify(payload, null, 2));
    // 0 success, 1 connection/protocol failure, 2 the DSH task did not complete normally.
    if (action === 'send' && payload.status !== 'completed') process.exitCode = 2;
    else if (action === 'cancel' && !['completed', 'aborted', 'cancelled', 'cancel-requested'].includes(payload.status)) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify(error.bridgeResult ?? { requestId: null, sessionId: null, status: 'failed', reply: '', errorCode: 'internal-error' }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
