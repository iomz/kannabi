import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

/** The GS1 toolkit is GS1 as Kannabi needs it, and imports nothing of
 * Kannabi: this keeps it so. */

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
