import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { watch } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from './bridge.mjs';
import { publishEndpoint } from './transport.mjs';

const run = promisify(execFile);
const windows = process.platform === 'win32';
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
async function ps(script, target) {
  const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference = 'Stop';\n" + script, 'utf16le').toString('base64')], {
    env: { ...process.env, PSModulePath: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'), BRIDGE_TEST_PATH: target }, windowsHide: true, timeout: 10_000,
  });
  return stdout.trim();
}
async function privateDirectory(dir) {
  await ps(`
    $ErrorActionPreference = 'Stop'
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $env:BRIDGE_TEST_PATH /inheritance:r /grant:r "*\${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'fixture-acl-failed' }
  `, dir);
}

test('endpoint capability stays inside the private directory throughout publishing', { skip: !windows }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-publish-acl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'private');
  const source = join(root, 'broad-temp');
  await mkdir(dir);
  await mkdir(source);
  await privateDirectory(dir);
  // This directory contains only fake fixture data. Give it a known extra
  // reader to make the original cross-directory move fail deterministically.
  await ps(`& icacls.exe $env:BRIDGE_TEST_PATH /grant '*S-1-1-0:(OI)(CI)R' | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'fixture-acl-failed' }`, source);
  const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  const stateFile = join(dir, 'endpoint.json');
  let publicTempUsed = false;
  const watcher = watch(source, () => { publicTempUsed = true; });
  try {
    process.env.TEMP = source;
    process.env.TMP = source;
    await publishEndpoint(stateFile, { pipe: 'fixture-only', token: 'not-a-real-capability', pid: process.pid });
    await new Promise(resolve => setTimeout(resolve, 50));
  } finally {
    watcher.close();
    for (const key of ['TEMP', 'TMP']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
  assert.equal(publicTempUsed, false, 'capability must never be staged in the broad temp directory');
  const unexpected = await ps(`
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544')
    $rules = (Get-Acl -LiteralPath $env:BRIDGE_TEST_PATH).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    @($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $allowed }).Count
  `, stateFile);
  assert.equal(unexpected, '0', 'endpoint must allow only the current user, SYSTEM, and administrators');
});

test('doctor rejects unexpected allow rules on both the directory and endpoint', { skip: !windows }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-doctor-acl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await privateDirectory(root);
  const stateFile = join(root, 'endpoint.json');
  await publishEndpoint(stateFile, { pipe: 'fixture-only', token: 'not-a-real-capability', pid: process.pid });
  const profileFile = join(root, 'profile.yml');
  await writeFile(profileFile, '');
  const before = await doctor({ stateFile, profileFile });
  assert.equal(before.checks.find(c => c.item === 'state-dir-acl')?.ok, true, before.checks.find(c => c.item === 'state-dir-acl')?.detail);
  assert.equal(before.checks.find(c => c.item === 'endpoint-file-acl')?.ok, true, before.checks.find(c => c.item === 'endpoint-file-acl')?.detail);
  await ps(`& icacls.exe $env:BRIDGE_TEST_PATH /grant '*S-1-1-0:R' | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'fixture-acl-failed' }`, stateFile);
  const fileBad = await doctor({ stateFile, profileFile });
  assert.equal(fileBad.checks.find(c => c.item === 'endpoint-file-acl')?.ok, false);
  await ps(`& icacls.exe $env:BRIDGE_TEST_PATH /grant '*S-1-1-0:R' | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'fixture-acl-failed' }`, root);
  const dirBad = await doctor({ stateFile, profileFile });
  assert.equal(dirBad.checks.find(c => c.item === 'state-dir-acl')?.ok, false);
});

test('doctor validates nearest package.json even when plugin exports look valid', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-doctor-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestFile = join(root, 'dsh-plugin.mjs');
  await writeFile(manifestFile, "export const name = 'codex-dsh-message-bridge-poc'; export const version = '0.2.0';");
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'codex-dsh-message-bridge-poc', type: 'module' }));
  const result = await doctor({ stateFile: join(root, 'endpoint.json'), profileFile: join(root, 'missing.yml'), manifestFile });
  assert.equal(result.checks.find(c => c.item === 'manifest-version')?.ok, false);
  assert.equal(result.checks.find(c => c.item === 'manifest-version')?.detail, 'package-version-invalid');
});
