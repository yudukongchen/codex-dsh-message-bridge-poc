// Inspect actual ACL rules, not localized icacls strings. Only counts leave
// the subprocess; identities and capability contents are never printed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const defaultRun = promisify(execFile);
const script = `
  $ErrorActionPreference = 'Stop'
  try {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544')
    $acl = Get-Acl -LiteralPath $env:DSH_BRIDGE_ACL_PATH
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $allows = @($rules | Where-Object { $_.AccessControlType -eq 'Allow' })
    $unexpected = @($allows | Where-Object { $_.IdentityReference.Value -notin $allowed }).Count
    $denies = @($rules | Where-Object { $_.AccessControlType -eq 'Deny' }).Count
    $full = [Security.AccessControl.FileSystemRights]::FullControl
    $missing = 0
    foreach ($identity in $allowed) {
      $found = @($allows | Where-Object { $_.IdentityReference.Value -eq $identity -and ($_.FileSystemRights -band $full) -eq $full })
      if ($found.Count -eq 0) { $missing++ }
    }
    @{ ok = ($unexpected -eq 0 -and $missing -eq 0 -and $denies -eq 0); unexpected = $unexpected; missing = $missing; denies = $denies } | ConvertTo-Json -Compress
  } catch { '{"ok":false,"errorCode":"acl-unreadable"}' }
`;

const counts = result => `额外允许授权 ${result.unexpected} 项，缺少完全控制授权 ${result.missing} 项，拒绝授权 ${result.denies} 项`;
// `reason` lets callers separate "proven unsafe" from "could not verify".
// `run` is injectable so tests can classify failures without spawning.
export async function inspectPrivateAcl(path, run = defaultRun) {
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported', detail: 'Windows ACL 检查需要 Windows。' };
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let stdout;
  try {
    ({ stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      // A pwsh parent can export PSModulePath entries that Windows PowerShell
      // cannot load. Use its own built-ins so Get-Acl cannot fail autoloading.
      env: { ...process.env, PSModulePath: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'), DSH_BRIDGE_ACL_PATH: path }, windowsHide: true, timeout: 8_000, maxBuffer: 16_384,
    }));
  } catch (error) {
    // Refusing to start and refusing to store are different failures: report
    // which one happened instead of folding both into an ACL verdict.
    return classifyProbeFailure(error);
  }
  let result;
  try { result = JSON.parse(stdout.trim()); } catch { return { ok: false, reason: 'acl-unreadable', detail: '权限自检输出无法解析，请手动检查目录权限' }; }
  if (result.errorCode) return { ok: false, reason: 'acl-unreadable', detail: '无法读取 ACL，请手动检查' };
  if (typeof result.ok !== 'boolean') return { ok: false, reason: 'acl-unreadable', detail: '权限自检输出不完整，请手动检查' };
  if (!result.ok) return { ok: false, reason: 'acl-unsafe', detail: counts(result) };
  return { ok: true, reason: 'ok', detail: counts(result) };
}

function classifyProbeFailure(error) {
  const code = error?.code;
  if (error?.killed) return { ok: false, reason: 'probe-failed', detail: '权限自检超时或异常终止，目录权限未验证' };
  if (code === 'EPERM' || code === 'EACCES') return { ok: false, reason: 'probe-unavailable', detail: `系统拒绝启动权限自检子进程（${code}），可能被沙箱或安全策略拦截，目录权限未验证` };
  if (code === 'ENOENT') return { ok: false, reason: 'probe-unavailable', detail: '找不到 Windows PowerShell（ENOENT），无法执行权限自检' };
  return { ok: false, reason: 'probe-failed', detail: `权限自检子进程执行失败（${code ?? '未知错误'}），目录权限未验证` };
}
