#requires -Version 7.0
param([string]$ProfileFile)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bridge-config-lib.ps1')

if (-not $ProfileFile) { $ProfileFile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml' }
$profileFile = $ProfileFile
if (-not (Test-Path -LiteralPath $profileFile)) { Write-Output '未找到 DSH 配置文件，无需卸载。'; exit 0 }
$original = [IO.File]::ReadAllText($profileFile)

# Same integrity rules as install: refuse to edit a file with half or duplicated markers.
$blockMatch = Get-BridgeBlock -Text $original
if ($null -eq $blockMatch) { Write-Output '未发现此扩展配置。'; exit 0 }

$updated = $original.Remove($blockMatch.Index, $blockMatch.Length)
$backupFile = Get-BridgeUniqueBackup -SourceFile $profileFile -Suffix "before-bridge-uninstall-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
[IO.File]::WriteAllText($backupFile, $original, [Text.UTF8Encoding]::new($false))
Write-BridgeFileAtomic -TargetFile $profileFile -ExpectedOriginal $original -NewText $updated

Write-Output "已移除扩展配置（其他插件与会话保留）。配置备份：$backupFile"
Write-Output '重启 DSH 后生效。'
