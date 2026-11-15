import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { compose, generated, sync } from './plugins.mjs';

const script = fileURLToPath(new URL('./plugins.mjs', import.meta.url));

/** A directory shaped like a Kannabi checkout, as far as the script looks. */
function checkout(t, list, fallback = { plugins: [] }) {
  const root = mkdtempSync(join(tmpdir(), 'kannabi-plugins-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['server', 'web', 'plugins']) mkdirSync(join(root, directory));
  writeFileSync(join(root, 'kannabi.plugins.default.json'), JSON.stringify(fallback));
  if (list !== undefined) writeFileSync(join(root, 'kannabi.plugins.json'), typeof list === 'string' ? list : JSON.stringify(list));
  return root;
}

function plugin(root, id, { web = true, routes = true } = {}) {
  mkdirSync(join(root, 'plugins', id, 'web'), { recursive: true });
  writeFileSync(join(root, 'plugins', id, 'index.ts'), 'export default {};\n');
  if (web) writeFileSync(join(root, 'plugins', id, 'web', 'index.tsx'), 'export default {};\n');
  if (routes) writeFileSync(join(root, 'plugins', id, 'web', 'routes.ts'), 'export const routes = [];\nexport const groupRoutes = [];\n');
}

const read = (root, path) => readFileSync(join(root, path), 'utf8');

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

/** A plugin repository with one tagged commit and a later untagged one. */
function repository(t) {
  const source = mkdtempSync(join(tmpdir(), 'kannabi-plugin-source-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  git(source, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(source, 'index.ts'), 'export default { version: 1 };\n');
  git(source, 'add', '.');
  git(source, 'commit', '--quiet', '-m', 'one');
  git(source, 'tag', 'v0.1.0');
  writeFileSync(join(source, 'index.ts'), 'export default { version: 2 };\n');
  git(source, 'commit', '--quiet', '-am', 'two');
  return source;
}

test('a checkout with no plugin composes nothing', (t) => {
  const root = checkout(t);
  assert.deepEqual(compose(root), { file: 'kannabi.plugins.default.json', plugins: [] });
  assert.match(read(root, generated.server), /export const definitions: readonly PluginDefinition\[\] = \[\];/);
  assert.match(read(root, generated.web), /export const plugins: readonly WebPlugin\[\] = \[\];/);
  assert.match(read(root, generated.routes), /export const pluginRoutes: RouteConfigEntry\[\] = \[\];/);
  assert.doesNotMatch(read(root, generated.server) + read(root, generated.web) + read(root, generated.routes), /plugins\//);
});

test('listed plugins are composed in list order, each through the entries it has', (t) => {
  const root = checkout(t, { plugins: [{ id: 'first' }, { id: 'server-only' }, { id: 'last' }] });
  plugin(root, 'first');
  plugin(root, 'server-only', { web: false, routes: false });
  plugin(root, 'last', { routes: false });
  assert.deepEqual(compose(root).plugins, ['first', 'server-only', 'last']);
  const server = read(root, generated.server);
  assert.ok(server.indexOf('plugins/first/index.js') < server.indexOf('plugins/server-only/index.js'));
  assert.ok(server.indexOf('plugins/server-only/index.js') < server.indexOf('plugins/last/index.js'));
  assert.match(server, /= \[plugin0, plugin1, plugin2\];/);
  assert.match(read(root, generated.web), /= \[plugin0, plugin2\];/);
  assert.doesNotMatch(read(root, generated.web), /server-only/);
  assert.match(read(root, generated.routes), /pluginRoutes: RouteConfigEntry\[\] = \[\.\.\.plugin0\.routes\];/);
  assert.match(read(root, generated.routes), /pluginGroupRoutes: RouteConfigEntry\[\] = \[\.\.\.plugin0\.groupRoutes\];/);
});

test('a directory the list does not name is not built in', (t) => {
  const root = checkout(t, { plugins: [{ id: 'listed' }] });
  plugin(root, 'listed');
  plugin(root, 'unlisted');
  compose(root);
  assert.doesNotMatch(read(root, generated.server) + read(root, generated.web) + read(root, generated.routes), /unlisted/);
});

test('the deployment list replaces the default one', (t) => {
  const root = checkout(t, { plugins: [] }, { plugins: [{ id: 'shipped' }] });
  plugin(root, 'shipped');
  assert.deepEqual(compose(root), { file: 'kannabi.plugins.json', plugins: [] });
});

test('composing leaves an unchanged file untouched', (t) => {
  const root = checkout(t);
  compose(root);
  const modified = () => Object.values(generated).map((path) => statSync(join(root, path)).mtimeMs);
  const before = modified();
  compose(root);
  assert.deepEqual(modified(), before);
});

for (const [name, list, message] of [
  ['text that is not JSON', '{', /could not be read as JSON/],
  ['a list that is not an object of plugins', [], /must be an object holding only a "plugins" array/],
  ['an unknown top-level key', { plugins: [], discover: true }, /only a "plugins" array/],
  ['an id that could leave the plugins directory', { plugins: [{ id: '../server' }] }, /lowercase token/],
  ['an uppercase id', { plugins: [{ id: 'GS1' }] }, /lowercase token/],
  ['a plugin listed twice', { plugins: [{ id: 'a' }, { id: 'a' }] }, /lists "a" twice/],
  ['an unknown key on an entry', { plugins: [{ id: 'a', enabled: false }] }, /unknown key "enabled"/],
  ['a repository with no ref', { plugins: [{ id: 'a', repository: 'https://example.invalid/a.git' }] }, /always pinned to a ref/],
  ['a ref with no repository', { plugins: [{ id: 'a', ref: 'v1' }] }, /"ref" and no "repository"/],
  ['a repository git would read as an option', { plugins: [{ id: 'a', repository: '--upload-pack=x', ref: 'v1' }] }, /needs a "repository"/],
  ['a ref git would read as an option', { plugins: [{ id: 'a', repository: 'https://example.invalid/a.git', ref: '-f' }] }, /needs a "ref"/],
  ['a listed plugin that is not there', { plugins: [{ id: 'absent' }] }, /plugins\/absent\/index\.ts does not exist/],
]) {
  test(`refuses ${name}`, (t) => {
    const root = checkout(t, list);
    assert.throws(() => compose(root), message);
    assert.equal(existsSync(join(root, generated.server)), false);
  });
}

test('sync clones a listed repository at its pinned tag, not at its newest commit', (t) => {
  const source = repository(t);
  const root = checkout(t, { plugins: [{ id: 'fetched', repository: source, ref: 'v0.1.0' }] });
  const lines = [];
  assert.deepEqual(sync(root, (line) => lines.push(line)).plugins, ['fetched']);
  assert.match(read(root, 'plugins/fetched/index.ts'), /version: 1/);
  assert.equal(git(join(root, 'plugins/fetched'), 'rev-parse', 'HEAD'), git(source, 'rev-parse', 'v0.1.0'));
  assert.match(lines[0], /^fetched: v0\.1\.0 \([0-9a-f]{12}\) from /);
  assert.match(read(root, generated.server), /plugins\/fetched\/index\.js/);
});

test('sync moves an existing clone to a new ref, and accepts a branch or a commit', (t) => {
  const source = repository(t);
  const list = (ref) => ({ plugins: [{ id: 'fetched', repository: source, ref }] });
  const root = checkout(t, list('v0.1.0'));
  sync(root);
  writeFileSync(join(root, 'kannabi.plugins.json'), JSON.stringify(list('main')));
  sync(root);
  assert.match(read(root, 'plugins/fetched/index.ts'), /version: 2/);
  writeFileSync(join(root, 'kannabi.plugins.json'), JSON.stringify(list(git(source, 'rev-parse', 'v0.1.0'))));
  sync(root);
  assert.match(read(root, 'plugins/fetched/index.ts'), /version: 1/);
});

test('sync refuses a clone with local changes and leaves them alone', (t) => {
  const source = repository(t);
  const root = checkout(t, { plugins: [{ id: 'fetched', repository: source, ref: 'v0.1.0' }] });
  sync(root);
  writeFileSync(join(root, 'plugins/fetched/index.ts'), 'export default { mine: true };\n');
  assert.throws(() => sync(root), /has local changes/);
  assert.match(read(root, 'plugins/fetched/index.ts'), /mine: true/);
});

test('sync refuses a directory that is not a clone, a clone of another repository, and an unknown ref', (t) => {
  const source = repository(t);
  const other = repository(t);
  const root = checkout(t, { plugins: [{ id: 'fetched', repository: source, ref: 'v0.1.0' }] });
  plugin(root, 'fetched');
  assert.throws(() => sync(root), /exists and is not a clone/);
  rmSync(join(root, 'plugins/fetched'), { recursive: true });
  sync(root);
  writeFileSync(join(root, 'kannabi.plugins.json'), JSON.stringify({ plugins: [{ id: 'fetched', repository: other, ref: 'v0.1.0' }] }));
  assert.throws(() => sync(root), /was cloned from/);
  writeFileSync(join(root, 'kannabi.plugins.json'), JSON.stringify({ plugins: [{ id: 'fetched', repository: source, ref: 'v9' }] }));
  assert.throws(() => sync(root), /"v9" names no commit/);
});

test('sync leaves a plugin kept in the checkout alone', (t) => {
  const root = checkout(t, { plugins: [{ id: 'kept' }] });
  plugin(root, 'kept');
  assert.deepEqual(sync(root).plugins, ['kept']);
  assert.equal(existsSync(join(root, 'plugins/kept/.git')), false);
});

test('the command reports a refusal on stderr and exits non-zero', (t) => {
  const root = checkout(t, { plugins: [{ id: 'absent' }] });
  const result = spawnSync(process.execPath, [script, 'compose'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugins\/absent\/index\.ts does not exist/);
  assert.equal(result.stdout, '');
  assert.equal(spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' }).status, 1);
});
