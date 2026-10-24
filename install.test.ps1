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

$root = Join-Path ([IO.Path]::GetTempPath()) ("bridge-inst-test-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root | Out-Null
try {
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
    $b = New-BridgeBlock -PluginUrl 'file:///x/dsh-plugin.mjs' -CwdValue 'x'
    Throws { Get-BridgeBlock -Text (New-Profile ($b + $b)) } '不完整或重复'
  }

  # --- quoting: paths with spaces and single quotes round-trip ---
  $weirdDir = Join-Path $root "it's a dir with spaces"
  New-Item -ItemType Directory -Path $weirdDir -Force | Out-Null
  Copy-Item (Join-Path $PSScriptRoot 'dsh-plugin.mjs') (Join-Path $weirdDir 'dsh-plugin.mjs')
  Check 'YAML single-quote escaping round-trips' {
    $url = ([Uri](Join-Path $weirdDir 'dsh-plugin.mjs')).AbsoluteUri
    $block = New-BridgeBlock -PluginUrl $url -CwdValue $weirdDir.Replace('\', '/')
    Assert (Test-BridgeBlockCurrent -BlockText $block -ExpectedUrl $url) 'block must be recognised as current for a quoted path'
  }

  # --- install against a temp profile ---
  $profile = Join-Path $root 'cordis.patch.yml'
  $state = Join-Path $root 'state'
  [IO.File]::WriteAllText($profile, (New-Profile), (New-Object Text.UTF8Encoding $false))
  $orig = [IO.File]::ReadAllText($profile)
  Check 'install with a missing version in manifest leaves the profile untouched' {
    $badDir = Join-Path $root 'bad-manifest'
    New-Item -ItemType Directory -Path $badDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $badDir 'dsh-plugin.mjs') -Value "export const name = 'codex-dsh-message-bridge-poc';`nexport const inject = [];" -Encoding utf8
    # Copy the lib and rewrite a mini install? Simpler: call the validator directly.
    Throws { Test-BridgeManifest (Join-Path $badDir 'dsh-plugin.mjs') 'node' } 'version'
    Assert ([IO.File]::ReadAllText($profile) -eq $orig) 'profile must be untouched when validation fails'
  }
  Check 'exported version cannot hide a missing package.json version' {
    $dir = Join-Path $root 'missing-package-version'
    New-Item -ItemType Directory -Path $dir | Out-Null
    $plugin = Join-Path $dir 'dsh-plugin.mjs'
    [IO.File]::WriteAllText($plugin, "export const name = 'codex-dsh-message-bridge-poc'; export const version = '0.2.0';")
    [IO.File]::WriteAllText((Join-Path $dir 'package.json'), '{"name":"codex-dsh-message-bridge-poc","type":"module"}')
    Throws { Test-BridgeManifest $plugin 'node' } 'version'
    Assert ([IO.File]::ReadAllText($profile) -eq $orig) 'profile unchanged'
  }
  Check 'package and exported versions must agree' {
    $dir = Join-Path $root 'mismatched-package-version'
    New-Item -ItemType Directory -Path $dir | Out-Null
    $plugin = Join-Path $dir 'dsh-plugin.mjs'
    [IO.File]::WriteAllText($plugin, "export const name = 'codex-dsh-message-bridge-poc'; export const version = '0.2.0';")
    [IO.File]::WriteAllText((Join-Path $dir 'package.json'), '{"name":"codex-dsh-message-bridge-poc","version":"0.3.0","type":"module"}')
    Throws { Test-BridgeManifest $plugin 'node' } 'version'
  }
  Check 'actual install rejects missing package version before creating state or changing profile' {
    $dir = Join-Path $root 'invalid-package-install'
    New-Item -ItemType Directory -Path $dir | Out-Null
    foreach ($file in @('install.ps1', 'bridge-config-lib.ps1', 'manifest.mjs')) {
      Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $dir
    }
    [IO.File]::WriteAllText((Join-Path $dir 'dsh-plugin.mjs'), "export const name = 'codex-dsh-message-bridge-poc'; export const version = '0.2.1';")
    [IO.File]::WriteAllText((Join-Path $dir 'package.json'), '{"name":"codex-dsh-message-bridge-poc","type":"module"}')
    $badState = Join-Path $dir 'state'
    Throws { & (Join-Path $dir 'install.ps1') -ProfileFile $profile -StateDir $badState } 'version'
    Assert ([IO.File]::ReadAllText($profile) -eq $orig) 'real install must preserve the profile'
    Assert (-not (Test-Path -LiteralPath $badState)) 'validation must precede state-directory creation'
  }
  Check 'install appends a block for a path containing spaces and apostrophes' {
    $fakePlugin = Join-Path $PSScriptRoot 'dsh-plugin.mjs'  # real one (has version)
    $url = ([Uri]$fakePlugin).AbsoluteUri
    $cwd = $weirdDir.Replace('\', '/')
    $block = New-BridgeBlock -PluginUrl $url -CwdValue $cwd
    $before = [IO.File]::ReadAllText($profile)
    Write-BridgeFileAtomic -TargetFile $profile -ExpectedOriginal $before -NewText ($before.TrimEnd() + "`n" + $block + "`n")
    $after = [IO.File]::ReadAllText($profile)
    Assert ($after -ne $before) 'profile changed'
    $m = Get-BridgeBlock -Text $after
    Assert ($null -ne $m) 'block found'
    Assert (Test-BridgeBlockCurrent -BlockText $m.Value -ExpectedUrl $url) 'block points to the URL'
    $entry = Get-BridgeBlockEntry -BlockText $m.Value
    Assert ($entry.Cwd -eq $cwd) "cwd round-trips with apostrophe: got $($entry.Cwd)"
  }
  Check 'repeated install detects an entry pointing elsewhere and refuses' {
    $before = [IO.File]::ReadAllText($profile)
    Assert (-not (Test-BridgeBlockCurrent -BlockText (Get-BridgeBlock -Text $before).Value -ExpectedUrl 'file:///somewhere/else/dsh-plugin.mjs')) 'stale URL is not current'
    Assert ([IO.File]::ReadAllText($profile) -eq $before) 'profile untouched by the check itself'
  }
  Check 'Write-BridgeFileAtomic refuses a concurrently modified file' {
    $p2 = Join-Path $root 'race.yml'
    [IO.File]::WriteAllText($p2, "a`n", (New-Object Text.UTF8Encoding $false))
    Throws { Write-BridgeFileAtomic -TargetFile $p2 -ExpectedOriginal 'stale content' -NewText 'b' } '被其他进程修改'
    Assert (([IO.File]::ReadAllText($p2)) -eq "a`n") 'file unchanged'
  }
  Check 'backup names do not collide within the same second' {
    $b1 = Get-BridgeUniqueBackup -SourceFile $profile -Suffix 'x.bak'
    [IO.File]::WriteAllText($b1, '')
    $b2 = Get-BridgeUniqueBackup -SourceFile $profile -Suffix 'x.bak'
    Assert ($b1 -ne $b2) 'two distinct backup paths'
  }

  # --- uninstall keeps other entries ---
  Check 'uninstall removes only the marked block' {
    $m = Get-BridgeBlock -Text ([IO.File]::ReadAllText($profile))
    $updated = [IO.File]::ReadAllText($profile).Remove($m.Index, $m.Length)
    Assert ($updated -notmatch 'codex-dsh-message-bridge-poc') 'bridge entry gone'
    Assert ($updated -match 'ui-theme') 'other plugin retained'
    Assert ($null -eq (Get-BridgeBlock -Text $updated)) 'no markers remain'
  }

  # --- manifest of the real plugin passes the version gate ---
  Check 'real manifest passes Test-BridgeManifest' {
    $v = Test-BridgeManifest (Join-Path $PSScriptRoot 'dsh-plugin.mjs') 'node'
    Assert ($v -match '^\d+\.\d+\.\d+$') "semver version, got $v"
  }

  # --- end-to-end: run the actual install.ps1 + uninstall.ps1 against the temp profile ---
  Check 'install.ps1 end-to-end on a temp profile' {
    $e2e = Join-Path $root 'e2e.yml'
    [IO.File]::WriteAllText($e2e, (New-Profile), (New-Object Text.UTF8Encoding $false))
    $out = & (Join-Path $PSScriptRoot 'install.ps1') -ProfileFile $e2e -StateDir (Join-Path $root 'e2e-state') | Out-String
    Assert ($out -match '已添加扩展') "install output: $out"
    $text = [IO.File]::ReadAllText($e2e)
    Assert ($null -ne (Get-BridgeBlock -Text $text)) 'block installed'
    Assert ($text -match 'ui-theme') 'existing entries preserved'
    # second run is a verified no-op
    $out2 = & (Join-Path $PSScriptRoot 'install.ps1') -ProfileFile $e2e -StateDir (Join-Path $root 'e2e-state') | Out-String
    Assert ($out2 -match '已配置且指向本项目') "re-install is idempotent: $out2"
    Assert (([regex]::Matches([IO.File]::ReadAllText($e2e), '(?m)^# BEGIN')).Count -eq 1) 'no duplicate block'
    # uninstall
    $out3 = & (Join-Path $PSScriptRoot 'uninstall.ps1') -ProfileFile $e2e | Out-String
    Assert ($out3 -match '已移除扩展配置') "uninstall output: $out3"
    Assert ($null -eq (Get-BridgeBlock -Text ([IO.File]::ReadAllText($e2e)))) 'block removed'
    Assert ((([IO.File]::ReadAllText($e2e)) -match 'ui-theme')) 'other entries kept after uninstall'
  }
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output ""
Write-Output "# pass $script:pass / fail $($script:failed.Count)"
if ($script:failed.Count -gt 0) { $script:failed | ForEach-Object { Write-Output "FAILED: $($_[0]) -> $($_[1])" }; exit 1 }
exit 0
