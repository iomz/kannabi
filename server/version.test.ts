import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { displayVersion, kannabiVersion } from '../web/version.js';
import { packageVersion, versionDefine } from '../vite.config.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('one version is written down, and the build is what carries it', () => {
  // Package metadata is the single source. Nothing else may declare a version.
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(packageVersion, manifest.version);

  // The web bundle receives it by substitution rather than by a second
  // constant that could drift from the manifest.
  assert.equal(versionDefine, '__KANNABI_VERSION__');
  const source = readFileSync(new URL('../web/version.ts', import.meta.url), 'utf8');
  assert.match(source, /__KANNABI_VERSION__/);
  assert.doesNotMatch(source, new RegExp(manifest.version.replaceAll('.', '\\.')));

  // Imported outside a build there is nothing to substitute, so it says so
  // rather than reporting a version it cannot know.
  assert.equal(kannabiVersion, 'dev');
  assert.equal(displayVersion('0.2.0'), 'v0.2.0');
  assert.equal(displayVersion(kannabiVersion), 'vdev');
});
