#requires -Version 7.0
param(
  # Overridable for tests; defaults target the real desktop profile.
  [string]$ProfileFile,
  [string]$StateDir,
  [string]$Cwd,
  # The profile package is installed by the client shim, not by this script;
  # tests use a temp profile and skip the package gate.
  [switch]$SkipPackageCheck
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bridge-config-lib.ps1')

if (-not $ProfileFile) { $ProfileFile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml' }
if (-not $StateDir) { $StateDir = Join-Path $env:USERPROFILE '.dsh\bridge-poc' }
$profileFile = $ProfileFile
$stateDir = $StateDir
$manifestPath = Join-Path $PSScriptRoot 'dsh-plugin.mjs'
$packageName = 'codex-dsh-message-bridge-poc'
$cwdValue = if ($Cwd) { $Cwd.Replace('\', '/') } else { $PSScriptRoot.Replace('\', '/') }

# --- Validate everything BEFORE touching any configuration. ---
if (-not (Test-Path -LiteralPath $profileFile)) { throw "未找到 DSH 配置文件：$profileFile" }
$nodeVersion = Test-BridgeNode 'node'
$pluginVersion = Test-BridgeManifest $manifestPath 'node'
if (-not $SkipPackageCheck) {
  Test-BridgePackageInstalled -ProfileDir (Split-Path -Parent $profileFile) -PackageName $packageName -ExpectedVersion $pluginVersion
}

$original = [IO.File]::ReadAllText($profileFile)

# Protect the temporary IPC capability using Windows ACLs; mode 0600 alone is insufficient on Windows.
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $stateDir /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法保护 IPC 连接文件的状态目录权限，未修改 DSH 配置。' }

# Marker integrity check runs on the current file whether or not our block exists.
$blockMatch = Get-BridgeBlock -Text $original

if ($null -ne $blockMatch) {
  $entry = Get-BridgeBlockEntry -BlockText $blockMatch.Value
  if ($null -eq $entry) { throw '配置中的扩展条目无法解析；配置保持原样。' }
  if ($entry.Kind -eq 'legacy') {
    throw '配置中仍是旧版 file:// 条目。该标记块可能同时包含其他插件条目，本脚本不会整体删除；请先按 README 手工迁移为包名覆盖条目。配置保持原样。'
  }
  if ($entry.Name -ne $packageName) {
    throw "配置中的扩展条目指向 $($entry.Name)，与本包 $packageName 不一致；请先运行 uninstall.ps1。配置保持原样。"
  }
  if ($entry.Cwd -eq $cwdValue) {
    Write-Output "扩展已配置且指向本包（v$pluginVersion），无需修改。重启 DSH 后运行 node bridge.mjs ping。"
    exit 0
  }
  $block = New-BridgeBlock -PackageName $packageName -CwdValue $cwdValue
  $updated = $original.Remove($blockMatch.Index, $blockMatch.Length).Insert($blockMatch.Index, $block.Substring(1))
  $backupFile = Get-BridgeUniqueBackup -SourceFile $profileFile -Suffix "bridge-poc-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
  [IO.File]::WriteAllText($backupFile, $original, [Text.UTF8Encoding]::new($false))
  Write-BridgeFileAtomic -TargetFile $profileFile -ExpectedOriginal $original -NewText $updated
  Write-Output "已更新扩展工作目录为 $cwdValue（v$pluginVersion）。配置备份：$backupFile"
  Write-Output '保存 DSH 中的工作并完全退出，然后重新启动 DSH。'
  exit 0
}

$block = New-BridgeBlock -PackageName $packageName -CwdValue $cwdValue
$backupFile = Get-BridgeUniqueBackup -SourceFile $profileFile -Suffix "bridge-poc-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
[IO.File]::WriteAllText($backupFile, $original, [Text.UTF8Encoding]::new($false))
Write-BridgeFileAtomic -TargetFile $profileFile -ExpectedOriginal $original -NewText ($original.TrimEnd() + "`n" + $block + "`n")

Write-Output "已添加扩展 v$pluginVersion（Node $nodeVersion；包 $packageName）。配置备份：$backupFile"
Write-Output '保存 DSH 中的工作并完全退出，然后重新启动 DSH。'
