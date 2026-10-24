// The DSH package inventory reads the nearest package.json, not ESM exports.
// Install and doctor use the same check so they cannot disagree about metadata.
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const expectedName = 'codex-dsh-message-bridge-poc';
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export async function readPluginManifest(pluginPath) {
  const file = pluginPath.startsWith('file:') ? fileURLToPath(pluginPath) : resolve(pluginPath);
  let dir = dirname(file);
  let pkg;
  for (;;) {
    try { pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('package-manifest-invalid');
      const parent = dirname(dir);
      if (parent === dir) throw new Error('package-manifest-missing');
      dir = parent;
    }
  }
  if (!pkg || pkg.name !== expectedName) throw new Error('package-name-invalid');
  if (typeof pkg.version !== 'string' || !semver.test(pkg.version)) throw new Error('package-version-invalid');
  let exported;
  try { exported = await import(pathToFileURL(file).href); }
  catch { throw new Error('plugin-load-failed'); }
  if (exported.name !== pkg.name || exported.version !== pkg.version) throw new Error('plugin-package-mismatch');
  return { name: pkg.name, version: pkg.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify({ ok: true, ...await readPluginManifest(process.argv[2]) })); }
  catch (error) {
    console.log(JSON.stringify({ ok: false, errorCode: error.message }));
    process.exitCode = 1;
  }
}
