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

$entry = Get-BridgeBlockEntry -BlockText $blockMatch.Value
if ($null -eq $entry) { throw '配置中的扩展条目无法解析；未做修改。' }
if ($entry.Kind -eq 'legacy') {
  # The legacy marker block was written before the package-based install and
  # may also enclose unrelated entries (e.g. web providers). Removing it
  # wholesale would delete them, so migration is a manual, reviewed step.
  throw '检测到旧版 file:// 标记块；它可能同时包含其他插件条目，已停止卸载，配置未改动。请先按 README 手工迁移。'
}

$updated = $original.Remove($blockMatch.Index, $blockMatch.Length)
$backupFile = Get-BridgeUniqueBackup -SourceFile $profileFile -Suffix "before-bridge-uninstall-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
[IO.File]::WriteAllText($backupFile, $original, [Text.UTF8Encoding]::new($false))
Write-BridgeFileAtomic -TargetFile $profileFile -ExpectedOriginal $original -NewText $updated

Write-Output "已移除扩展配置（其他插件与会话保留）。配置备份：$backupFile"
Write-Output "插件包 $($entry.Name) 仍在 profile 中；如需彻底卸载，请用客户端 shim 执行：dsh plugin --profile desktop remove $($entry.Name)"
Write-Output '重启 DSH 后生效。'
