#requires -Version 7.0
# Shared validation rules for install.ps1 / uninstall.ps1.
# Pure string/structure logic lives here so the tests can cover it without touching the real profile.
Set-StrictMode -Version 2.0

$BridgeMarkerBegin = '# BEGIN codex-dsh-message-bridge-poc'
$BridgeMarkerEnd = '# END codex-dsh-message-bridge-poc'

function Get-BridgeBlock {
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
  $begin = [regex]::Matches($Text, '(?m)^# BEGIN codex-dsh-message-bridge-poc\r?\n')
  $end = [regex]::Matches($Text, '(?m)^# END codex-dsh-message-bridge-poc\r?\n?')
  if ($begin.Count -eq 0 -and $end.Count -eq 0) { return $null }
  if ($begin.Count -eq 0 -or $end.Count -eq 0) { throw '配置中存在半截扩展标记块（只有 END 或只有 BEGIN），已停止操作。' }
  if ($begin.Count -ne $end.Count -or $begin.Count -gt 1) { throw "扩展标记块不完整或重复（BEGIN=$($begin.Count) END=$($end.Count)），已停止操作。" }
  return [regex]::Match($Text, '(?ms)^# BEGIN codex-dsh-message-bridge-poc\r?\n.*?^# END codex-dsh-message-bridge-poc\r?\n?')
}

function Get-BridgeBlockEntry {
  param([Parameter(Mandatory)][AllowEmptyString()][string]$BlockText)
  $names = [regex]::Matches($BlockText, "(?m)^ +name: '((?:[^']|'')*)'")
  $ids = [regex]::Matches($BlockText, "(?m)^ +- id: (\S+)")
  if ($names.Count -ne 1 -or $ids.Count -ne 1 -or $ids[0].Groups[1].Value -ne 'codex-dsh-message-bridge-poc') { return $null }
  $name = $names[0].Groups[1].Value -replace "''", "'"
  $cwd = [regex]::Match($BlockText, "(?m)^ +cwd: '((?:[^']|'')*)'")
  $cwdValue = if ($cwd.Success) { $cwd.Groups[1].Value -replace "''", "'" } else { $null }
  return [pscustomobject]@{ Name = $name; Cwd = $cwdValue }
}

function Test-BridgeBlockCurrent {
  param([Parameter(Mandatory)][AllowEmptyString()][string]$BlockText, [Parameter(Mandatory)][string]$ExpectedUrl)
  $entry = Get-BridgeBlockEntry -BlockText $BlockText
  if ($null -eq $entry) { return $false }
  return $entry.Name -eq $ExpectedUrl
}

function ConvertTo-YamlSingleQuoted {
  # YAML single-quoted style: apostrophes double up; paths never contain newlines.
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  return "'" + ($Value.Replace("'", "''")) + "'"
}

function New-BridgeBlock {
  param([Parameter(Mandatory)][string]$PluginUrl, [Parameter(Mandatory)][string]$CwdValue)
  $q = ConvertTo-YamlSingleQuoted $PluginUrl
  $c = ConvertTo-YamlSingleQuoted $CwdValue
  return @"

$BridgeMarkerBegin
- insert:
    - id: codex-dsh-message-bridge-poc
      name: $q
      config:
        cwd: $c
$BridgeMarkerEnd
"@
}

function Get-BridgeUniqueBackup {
  # Avoid same-second collisions by appending a counter until the name is free.
  param([Parameter(Mandatory)][string]$SourceFile, [Parameter(Mandatory)][string]$Suffix)
  $base = "$SourceFile.$Suffix"
  $candidate = $base
  $i = 0
  while (Test-Path -LiteralPath $candidate) { $i++; $candidate = "$base-$i" }
  return $candidate
}

function Write-BridgeFileAtomic {
  # Write via temp file + same-volume replace, after re-confirming the on-disk
  # content still matches what the caller read (TOCTOU guard against parallel edits).
  param([Parameter(Mandatory)][string]$TargetFile, [Parameter(Mandatory)][AllowEmptyString()][string]$ExpectedOriginal, [Parameter(Mandatory)][AllowEmptyString()][string]$NewText)
  $current = [IO.File]::ReadAllText($TargetFile)
  if ($current -ne $ExpectedOriginal) { throw '配置文件在本次操作期间被其他进程修改，已停止写入；原文件未改动。' }
  $tmp = "$TargetFile.tmp-bridge-$(Get-Random)"
  try {
    [IO.File]::WriteAllText($tmp, $NewText, [Text.UTF8Encoding]::new($false))
    # Same-volume atomic overwrite. File.Replace is unusable from PowerShell: the
    # compiler coerces a null backup arg to "", tripping its empty-path guard.
    [IO.File]::Move($tmp, $TargetFile, $true)
  } catch {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
    throw
  }
}

function Test-BridgeManifest {
  # Validate the nearest package.json AND matching ESM exports. The package
  # inventory, not the ESM export, caused the original REQUEST_EXTENSION.
  param([Parameter(Mandatory)][string]$ManifestPath, [Parameter(Mandatory)][string]$NodePath)
  if (-not (Test-Path -LiteralPath $ManifestPath)) { throw "未找到插件文件：$ManifestPath" }
  $validator = Join-Path $PSScriptRoot 'manifest.mjs'
  $out = (& $NodePath $validator $ManifestPath 2>$null | Out-String).Trim()
  if (-not $out) { throw '无法读取插件 package.json 的 name/version（Node 执行失败），已停止安装。' }
  try { $parsed = $out | ConvertFrom-Json } catch { throw '插件 manifest 校验输出无法解析，已停止安装。' }
  if (-not $parsed.ok) { throw "插件 package.json 或模块的 name/version 校验失败（$($parsed.errorCode)），已停止安装。" }
  return $parsed.version
}

function Test-BridgeNode {
  param([Parameter(Mandatory)][string]$NodePath)
  if (-not (Get-Command $NodePath -ErrorAction SilentlyContinue)) { throw '未找到 node 命令，请安装 Node.js 22 或更高版本。' }
  $raw = (& $NodePath '--version' 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $raw -notmatch '^v(\d+)') { throw '无法确定 Node 版本，需要 Node.js 22 或更高版本。' }
  $major = [int]$Matches[1]
  if ($major -lt 22) { throw "Node.js 版本过低（$raw），需要 22 或更高版本。" }
  return $raw
}
