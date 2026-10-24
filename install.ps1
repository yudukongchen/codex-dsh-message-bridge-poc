#requires -Version 7.0
param(
  # Overridable for tests; defaults target the real desktop profile.
  [string]$ProfileFile,
  [string]$StateDir
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bridge-config-lib.ps1')

if (-not $ProfileFile) { $ProfileFile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml' }
if (-not $StateDir) { $StateDir = Join-Path $env:USERPROFILE '.dsh\bridge-poc' }
$profileFile = $ProfileFile
$stateDir = $StateDir
$manifestPath = Join-Path $PSScriptRoot 'dsh-plugin.mjs'

# --- Validate everything BEFORE touching any configuration (plan step 1). ---
if (-not (Test-Path -LiteralPath $profileFile)) { throw "未找到 DSH 配置文件：$profileFile" }
$nodeVersion = Test-BridgeNode 'node'
$pluginVersion = Test-BridgeManifest $manifestPath 'node'

$pluginUrl = ([Uri]$manifestPath).AbsoluteUri
$cwdValue = $PSScriptRoot.Replace('\', '/')

$original = [IO.File]::ReadAllText($profileFile)

# Protect the temporary IPC capability using Windows ACLs; mode 0600 alone is insufficient on Windows.
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $stateDir /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法保护 IPC 连接文件的状态目录权限，未修改 DSH 配置。' }

# Marker integrity check runs on the current file whether or not our block exists.
$blockMatch = Get-BridgeBlock -Text $original

if ($null -ne $blockMatch) {
  if (Test-BridgeBlockCurrent -BlockText $blockMatch.Value -ExpectedUrl $pluginUrl) {
    Write-Output "扩展已配置且指向本项目（v$pluginVersion），无需修改。重启 DSH 后运行 node bridge.mjs ping。"
    exit 0
  }
  throw '配置中已存在本扩展条目，但指向的插件文件与本项目不一致；请先运行 uninstall.ps1 再重新安装。配置保持原样。'
}

$block = New-BridgeBlock -PluginUrl $pluginUrl -CwdValue $cwdValue
$backupFile = Get-BridgeUniqueBackup -SourceFile $profileFile -Suffix "bridge-poc-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
[IO.File]::WriteAllText($backupFile, $original, [Text.UTF8Encoding]::new($false))
Write-BridgeFileAtomic -TargetFile $profileFile -ExpectedOriginal $original -NewText ($original.TrimEnd() + "`n" + $block + "`n")

Write-Output "已添加扩展 v$pluginVersion（Node $nodeVersion）。配置备份：$backupFile"
Write-Output '保存 DSH 中的工作并完全退出，然后重新启动 DSH。'
