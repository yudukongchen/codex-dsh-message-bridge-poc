#requires -Version 7.0
$ErrorActionPreference = 'Stop'
# Install/uninstall validation suite — runs entirely against temp profiles,
# never touching ~/.dsh. Invoke: pwsh -NoProfile -File .\install.test.ps1
. (Join-Path $PSScriptRoot 'bridge-config-lib.ps1')

$script:pass = 0; $script:failed = @()
function Check($name, [scriptblock]$body) {
  try { & $body; $script:pass++; Write-Output "ok - $name" }
  catch { $script:failed += ,@($name, $_.Exception.Message); Write-Output "not ok - $name : $($_.Exception.Message)" }
}
function Assert([bool]$cond, [string]$what) { if (-not $cond) { throw "assertion failed: $what" } }
function Throws([scriptblock]$body, [string]$pattern) {
  $msg = try { & $body | Out-Null; '' } catch { $_.Exception.Message }
  Assert ($msg -like "*$pattern*") "expected error containing '$pattern', got '$msg'"
}

$pkgName = 'codex-dsh-message-bridge-poc'

# A realistic profile skeleton with one unrelated plugin entry.
function New-Profile([string]$extra = '') {
  @"
- id: ui-theme
  name: "@x/dsh-client-ui-theme"
  config:
    preference: dark
$extra
"@
}
# Legacy marker block: the pre-package shape, with an unrelated entry enclosed.
function New-LegacyBlock {
  @"
# BEGIN codex-dsh-message-bridge-poc
- insert:
    - id: codex-dsh-message-bridge-poc
      name: 'file:///x/dsh-plugin.mjs'
      config:
        cwd: 'x'
- id: web
  name: "@deepseek-ai/dsh-web"
# END codex-dsh-message-bridge-poc
"@
}
# A temp profile directory that also carries the profile package.json.
function New-PackageProfile([string]$dir, [bool]$withDep = $true, [bool]$withBundle = $true, [string]$installedVersion = '0.3.1') {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $bundles = if ($withBundle) { '["codex-dsh-message-bridge-poc"]' } else { '[]' }
  $deps = if ($withDep) { '{"codex-dsh-message-bridge-poc":"file:x.tgz"}' } else { '{}' }
  $pkg = '{"name":"p","private":true,"dependencies":' + $deps + ',"dsh":{"profile":{"bundles":' + $bundles + '}}}'
  [IO.File]::WriteAllText((Join-Path $dir 'package.json'), $pkg)
  if ($installedVersion) {
    $nm = Join-Path $dir "node_modules\$pkgName"
    New-Item -ItemType Directory -Path $nm -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $nm 'package.json'), ('{"name":"' + $pkgName + '","version":"' + $installedVersion + '"}'))
  }
  $profile = Join-Path $dir 'cordis.patch.yml'
  [IO.File]::WriteAllText($profile, (New-Profile), (New-Object Text.UTF8Encoding $false))
  return $profile
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("bridge-inst-test-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root | Out-Null
try {
  $realVersion = Test-BridgeManifest (Join-Path $PSScriptRoot 'dsh-plugin.mjs') 'node'

  # --- marker integrity (half / duplicate blocks) ---
  Check 'Get-BridgeBlock returns null for clean profile' {
    Assert ($null -eq (Get-BridgeBlock -Text (New-Profile))) 'clean text must yield no block'
  }
  Check 'half marker (BEGIN without END) is rejected' {
    Throws { Get-BridgeBlock -Text (New-Profile "# BEGIN codex-dsh-message-bridge-poc`n- insert: junk") } '半截扩展标记块'
  }
  Check 'half marker (END without BEGIN) is rejected' {
    Throws { Get-BridgeBlock -Text (New-Profile "junk`n# END codex-dsh-message-bridge-poc`n") } '半截扩展标记块'
  }
  Check 'duplicated blocks are rejected' {
    $b = New-BridgeBlock -PackageName $pkgName -CwdValue 'x'
    Throws { Get-BridgeBlock -Text (New-Profile ($b + $b)) } '不完整或重复'
  }

  # --- block shapes ---
  Check 'legacy file:// insert block is identified for migration' {
    $entry = Get-BridgeBlockEntry -BlockText (New-LegacyBlock)
    Assert ($entry.Kind -eq 'legacy') "kind: $($entry.Kind)"
    Assert ($entry.Name -eq 'file:///x/dsh-plugin.mjs') "name: $($entry.Name)"
  }
  Check 'package override block is recognised as current' {
    $block = New-BridgeBlock -PackageName $pkgName -CwdValue 'x'
    Assert (Test-BridgeBlockCurrent -BlockText $block -PackageName $pkgName) 'package block must be current'
    Assert (-not (Test-BridgeBlockCurrent -BlockText $block -PackageName 'other-plugin')) 'other package is not current'
  }

  # --- quoting: paths with spaces and single quotes round-trip ---
  $weirdDir = Join-Path $root "it's a dir with spaces"
  New-Item -ItemType Directory -Path $weirdDir -Force | Out-Null
  Check 'YAML single-quote escaping round-trips' {
    $cwd = $weirdDir.Replace('\', '/')
    $block = New-BridgeBlock -PackageName $pkgName -CwdValue $cwd
    Assert (Test-BridgeBlockCurrent -BlockText $block -PackageName $pkgName) 'block must be recognised as current for a quoted path'
    $entry = Get-BridgeBlockEntry -BlockText $block
    Assert ($entry.Cwd -eq $cwd) "cwd round-trips with apostrophe: got $($entry.Cwd)"
  }

  # --- manifest gates ---
  Check 'install with a missing version in manifest leaves the profile untouched' {
    $badDir = Join-Path $root 'bad-manifest'
    New-Item -ItemType Directory -Path $badDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $badDir 'dsh-plugin.mjs') -Value "export const name = 'codex-dsh-message-bridge-poc';`nexport const inject = [];" -Encoding utf8
    Throws { Test-BridgeManifest (Join-Path $badDir 'dsh-plugin.mjs') 'node' } 'version'
  }
  Check 'exported version cannot hide a missing package.json version' {
    $dir = Join-Path $root 'missing-package-version'
    New-Item -ItemType Directory -Path $dir | Out-Null
    $plugin = Join-Path $dir 'dsh-plugin.mjs'
    [IO.File]::WriteAllText($plugin, "export const name = 'codex-dsh-message-bridge-poc'; export const version = '0.2.0';")
    [IO.File]::WriteAllText((Join-Path $dir 'package.json'), '{"name":"codex-dsh-message-bridge-poc","type":"module"}')
    Throws { Test-BridgeManifest $plugin 'node' } 'version'
  }
  Check 'package and exported versions must agree' {
    $dir = Join-Path $root 'mismatched-package-version'
    New-Item -ItemType Directory -Path $dir | Out-Null
    $plugin = Join-Path $dir 'dsh-plugin.mjs'
    [IO.File]::WriteAllText($plugin, "export const name = 'codex-dsh-message-bridge-poc'; export const version = '0.2.0';")
    [IO.File]::WriteAllText((Join-Path $dir 'package.json'), '{"name":"codex-dsh-message-bridge-poc","version":"0.3.0","type":"module"}')
    Throws { Test-BridgeManifest $plugin 'node' } 'version'
  }
  Check 'actual install rejects invalid manifest before creating state or changing profile' {
    $dir = Join-Path $root 'invalid-package-install'
    New-Item -ItemType Directory -Path $dir | Out-Null
    foreach ($file in @('install.ps1', 'bridge-config-lib.ps1', 'manifest.mjs')) {
      Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $dir
    }
    [IO.File]::WriteAllText((Join-Path $dir 'dsh-plugin.mjs'), "export const name = 'codex-dsh-message-bridge-poc'; export const version = '0.2.1';")
    [IO.File]::WriteAllText((Join-Path $dir 'package.json'), '{"name":"codex-dsh-message-bridge-poc","type":"module"}')
    $profile = Join-Path $dir 'cordis.patch.yml'
    [IO.File]::WriteAllText($profile, (New-Profile), (New-Object Text.UTF8Encoding $false))
    $before = [IO.File]::ReadAllText($profile)
    $badState = Join-Path $dir 'state'
    Throws { & (Join-Path $dir 'install.ps1') -ProfileFile $profile -StateDir $badState } 'version'
    Assert ([IO.File]::ReadAllText($profile) -eq $before) 'real install must preserve the profile'
    Assert (-not (Test-Path -LiteralPath $badState)) 'validation must precede state-directory creation'
  }

  # --- profile package gate ---
  Check 'install refuses when the package is missing from dependencies' {
    $p = New-PackageProfile (Join-Path $root 'gate-nodep') $false $true $realVersion
    Throws { & (Join-Path $PSScriptRoot 'install.ps1') -ProfileFile $p -StateDir (Join-Path $root 'gate-state-1') } '依赖中没有'
    Assert (-not (Test-Path -LiteralPath (Join-Path $root 'gate-state-1'))) 'no state dir on failure'
  }
  Check 'install refuses when the package is missing from dsh.profile.bundles' {
    $p = New-PackageProfile (Join-Path $root 'gate-nobundle') $true $false $realVersion
    Throws { & (Join-Path $PSScriptRoot 'install.ps1') -ProfileFile $p -StateDir (Join-Path $root 'gate-state-2') } 'bundles'
  }
  Check 'install refuses when node_modules version differs from the repository' {
    $p = New-PackageProfile (Join-Path $root 'gate-version') $true $true '0.0.9'
    Throws { & (Join-Path $PSScriptRoot 'install.ps1') -ProfileFile $p -StateDir (Join-Path $root 'gate-state-3') } '不一致'
  }
  Check 'install refuses when the profile package.json is missing' {
    $dir = Join-Path $root 'gate-nopkg'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $p = Join-Path $dir 'cordis.patch.yml'
    [IO.File]::WriteAllText($p, (New-Profile), (New-Object Text.UTF8Encoding $false))
    Throws { & (Join-Path $PSScriptRoot 'install.ps1') -ProfileFile $p -StateDir (Join-Path $root 'gate-state-4') } '未找到 profile 的 package.json'
  }

  # --- legacy migration guards ---
  Check 'install refuses a legacy file:// block instead of rewriting it' {
    $dir = Join-Path $root 'legacy-install'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $p = Join-Path $dir 'cordis.patch.yml'
    $text = (New-Profile) + (New-LegacyBlock)
    [IO.File]::WriteAllText($p, $text, (New-Object Text.UTF8Encoding $false))
    Throws { & (Join-Path $PSScriptRoot 'install.ps1') -ProfileFile $p -StateDir (Join-Path $root 'legacy-state') -SkipPackageCheck } '旧版 file://'
    Assert ([IO.File]::ReadAllText($p) -eq $text) 'profile unchanged'
  }
  Check 'uninstall refuses a legacy block and preserves unrelated enclosed entries' {
    $dir = Join-Path $root 'legacy-uninstall'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $p = Join-Path $dir 'cordis.patch.yml'
    $text = (New-Profile) + (New-LegacyBlock)
    [IO.File]::WriteAllText($p, $text, (New-Object Text.UTF8Encoding $false))
    Throws { & (Join-Path $PSScriptRoot 'uninstall.ps1') -ProfileFile $p } '旧版 file://'
    Assert ([IO.File]::ReadAllText($p) -eq $text) 'profile unchanged'
    Assert ([IO.File]::ReadAllText($p) -match 'dsh-web') 'unrelated enclosed entry retained'
  }

  # --- install / uninstall end-to-end on a temp profile ---
  Check 'install.ps1 end-to-end writes a package override and is idempotent' {
    $e2e = Join-Path $root 'e2e.yml'
    [IO.File]::WriteAllText($e2e, (New-Profile), (New-Object Text.UTF8Encoding $false))
    $out = & (Join-Path $PSScriptRoot 'install.ps1') -ProfileFile $e2e -StateDir (Join-Path $root 'e2e-state') -SkipPackageCheck | Out-String
    Assert ($out -match '已添加扩展') "install output: $out"
    $text = [IO.File]::ReadAllText($e2e)
    Assert ($null -ne (Get-BridgeBlock -Text $text)) 'block installed'
    Assert ($text -match 'ui-theme') 'existing entries preserved'
    Assert ($text -match "name: '$pkgName'") 'block uses the package name'
    Assert ($text -notmatch 'file:///') 'no file URL written'
    $out2 = & (Join-Path $PSScriptRoot 'install.ps1') -ProfileFile $e2e -StateDir (Join-Path $root 'e2e-state') -SkipPackageCheck | Out-String
    Assert ($out2 -match '已配置且指向本包') "re-install is idempotent: $out2"
    Assert (([regex]::Matches([IO.File]::ReadAllText($e2e), '(?m)^# BEGIN')).Count -eq 1) 'no duplicate block'
  }
  Check 'install.ps1 updates cwd without touching other entries' {
    $e2e = Join-Path $root 'e2e.yml'
    $newCwd = (Join-Path $root 'other cwd').Replace('\', '/')
    $out = & (Join-Path $PSScriptRoot 'install.ps1') -ProfileFile $e2e -StateDir (Join-Path $root 'e2e-state') -SkipPackageCheck -Cwd $newCwd | Out-String
    Assert ($out -match '已更新扩展工作目录') "update output: $out"
    $entry = Get-BridgeBlockEntry -BlockText (Get-BridgeBlock -Text ([IO.File]::ReadAllText($e2e))).Value
    Assert ($entry.Cwd -eq $newCwd) "cwd updated: $($entry.Cwd)"
    Assert (([IO.File]::ReadAllText($e2e)) -match 'ui-theme') 'other entries preserved'
  }
  Check 'uninstall.ps1 removes only the package block' {
    $e2e = Join-Path $root 'e2e.yml'
    $out3 = & (Join-Path $PSScriptRoot 'uninstall.ps1') -ProfileFile $e2e | Out-String
    Assert ($out3 -match '已移除扩展配置') "uninstall output: $out3"
    $text = [IO.File]::ReadAllText($e2e)
    Assert ($null -eq (Get-BridgeBlock -Text $text)) 'block removed'
    Assert ($text -match 'ui-theme') 'other entries kept after uninstall'
  }

  Check 'Write-BridgeFileAtomic refuses a concurrently modified file' {
    $p2 = Join-Path $root 'race.yml'
    [IO.File]::WriteAllText($p2, "a`n", (New-Object Text.UTF8Encoding $false))
    Throws { Write-BridgeFileAtomic -TargetFile $p2 -ExpectedOriginal 'stale content' -NewText 'b' } '被其他进程修改'
    Assert (([IO.File]::ReadAllText($p2)) -eq "a`n") 'file unchanged'
  }
  Check 'backup names do not collide within the same second' {
    $p3 = Join-Path $root 'backup.yml'
    [IO.File]::WriteAllText($p3, 'x', (New-Object Text.UTF8Encoding $false))
    $b1 = Get-BridgeUniqueBackup -SourceFile $p3 -Suffix 'x.bak'
    [IO.File]::WriteAllText($b1, '')
    $b2 = Get-BridgeUniqueBackup -SourceFile $p3 -Suffix 'x.bak'
    Assert ($b1 -ne $b2) 'two distinct backup paths'
  }
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output ""
Write-Output "# pass $script:pass / fail $($script:failed.Count)"
if ($script:failed.Count -gt 0) { $script:failed | ForEach-Object { Write-Output "FAILED: $($_[0]) -> $($_[1])" }; exit 1 }
exit 0
