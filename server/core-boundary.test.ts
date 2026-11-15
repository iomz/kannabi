import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

/** Which way imports may run between Kannabi core and its plugins.
 *
 * Core is everything under `server/`. A plugin lives under `plugins/<id>/`
 * and may import core; core imports no plugin. The one exception is the
 * composition file, whose whole job is to name the installed plugins, and
 * the entry points that start a process import that file and nothing else of
 * a plugin's.
 */
const composition = 'server/composition.ts';
const entryPoints = ['server/index.ts', 'server/mcp.ts', 'server/link-identity.ts'];

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

/** Every relative import of a file, as a path from the repository root. */
function imports(path: string): string[] {
  const found = [...readFileSync(path, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)]
    .map((match) => relative('.', resolve(dirname(path), match[1])).replace(/\.(js|tsx?)$/, ''));
  return [...new Set(found)].sort();
}

const inPlugin = (path: string) => path.startsWith('plugins/');

test('core imports no plugin', () => {
  const found: Record<string, string[]> = {};
  for (const path of sources('server')) {
    const reached = imports(path);
    if (path === composition) continue;
    assert.ok(entryPoints.includes(path) || !reached.includes('server/composition'),
      `${path} imports the composition file; core takes what was composed as a value`);
    const plugins = reached.filter(inPlugin);
    if (plugins.length) found[path] = plugins;
  }
  assert.deepEqual(found, {});
});

test('the composition file is the only place a plugin is named', () => {
  assert.deepEqual(imports(composition).filter(inPlugin), ['plugins/gs1/index']);
});

test('the GS1 toolkit imports nothing of Kannabi', () => {
  // The toolkit is GS1 as Kannabi needs it, and stands without Kannabi: it
  // refuses with its own error, and the adapter beside it is where that
  // becomes a Kannabi validation error.
  const found: Record<string, string[]> = {};
  for (const path of sources('plugins/gs1/toolkit')) {
    const outside = imports(path).filter((target) => !target.startsWith('plugins/gs1/toolkit/'));
    if (outside.length) found[path] = outside;
  }
  assert.deepEqual(found, {});
});

test('the web client names a plugin only where it is composed', () => {
  // `web/plugins.ts` says which plugins the client is built with, and
  // `web/routes.ts` takes their routes. Every other module asks the composed
  // value, so a build without a plugin is those two files with fewer lines.
  const found: Record<string, string[]> = {};
  for (const path of sources('web')) {
    const plugins = imports(path).filter(inPlugin);
    if (plugins.length) found[path] = plugins;
  }
  assert.deepEqual(found, {
    'web/plugins.ts': ['plugins/gs1/web/index'],
    'web/routes.ts': ['plugins/gs1/web/routes'],
  });
});
