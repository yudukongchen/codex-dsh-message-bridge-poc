// Inspect actual ACL rules, not localized icacls strings. Only counts leave
// the subprocess; identities and capability contents are never printed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);
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

export async function inspectPrivateAcl(path) {
  if (process.platform !== 'win32') return { ok: false, detail: 'Windows ACL 检查需要 Windows。' };
  try {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      // A pwsh parent can export PSModulePath entries that Windows PowerShell
      // cannot load. Use its own built-ins so Get-Acl cannot fail autoloading.
      env: { ...process.env, PSModulePath: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'), DSH_BRIDGE_ACL_PATH: path }, windowsHide: true, timeout: 8_000, maxBuffer: 16_384,
    });
    const result = JSON.parse(stdout.trim());
    if (result.errorCode) return { ok: false, detail: '无法读取 ACL，请手动检查。' };
    return { ok: result.ok === true, detail: `额外允许授权 ${result.unexpected} 项，缺少完全控制授权 ${result.missing} 项，拒绝授权 ${result.denies} 项` };
  } catch { return { ok: false, detail: '无法读取 ACL，请手动检查。' }; }
}
