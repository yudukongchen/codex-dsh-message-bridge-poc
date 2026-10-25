import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectPrivateAcl } from './windows-acl.mjs';

const windows = process.platform === 'win32';
const reply = value => async () => ({ stdout: JSON.stringify(value) });
const failWith = code => async () => { throw Object.assign(new Error(code), { code }); };

test('clean ACL counts as private', { skip: !windows }, async () => {
  const result = await inspectPrivateAcl('C:\\fixture', reply({ ok: true, unexpected: 0, missing: 0, denies: 0 }));
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'ok');
});

test('broad or missing grants are a proven unsafe verdict', { skip: !windows }, async () => {
  const result = await inspectPrivateAcl('C:\\fixture', reply({ ok: false, unexpected: 2, missing: 1, denies: 0 }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'acl-unsafe');
  assert.match(result.detail, /额外允许授权 2 项/);
});

test('a probe blocked by the OS is not reported as an ACL violation', { skip: !windows }, async () => {
  for (const code of ['EPERM', 'EACCES', 'ENOENT']) {
    const result = await inspectPrivateAcl('C:\\fixture', failWith(code));
    assert.equal(result.ok, false, code);
    assert.equal(result.reason, 'probe-unavailable', code);
    assert.match(result.detail, new RegExp(code));
  }
});

test('an unreadable or malformed probe is unverified, not unsafe', { skip: !windows }, async () => {
  const unreadable = await inspectPrivateAcl('C:\\fixture', reply({ ok: false, errorCode: 'acl-unreadable' }));
  assert.equal(unreadable.reason, 'acl-unreadable');
  const malformed = await inspectPrivateAcl('C:\\fixture', async () => ({ stdout: 'not json' }));
  assert.equal(malformed.reason, 'acl-unreadable');
});
