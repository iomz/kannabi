import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { RouteConfigEntry } from '@react-router/dev/routes';
import routes from '../web/routes.js';
import { clientBuild } from './client-build.js';

const applicationDocument = '<!doctype html><title>Kannabi</title>';
const bundle = 'export {};';
let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kannabi-client-build-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), applicationDocument);
  await writeFile(join(root, 'assets', 'entry-abc123.js'), bundle);
});
after(() => rm(root, { recursive: true, force: true }));

const get = (path: string, init?: RequestInit) => clientBuild(root).request(path, init);

async function assertApplicationDocument(path: string) {
  const response = await get(path);
  assert.equal(response.status, 200, path);
  assert.match(response.headers.get('content-type') ?? '', /^text\/html/, path);
  assert.equal(await response.text(), applicationDocument, path);
}

test('a document request for an application route gets the application document', async () => {
  for (const path of ['/', '/lookup', '/asset/0199', '/groups/abc/people']) await assertApplicationDocument(path);
});

test('a document request for the Report Asset page gets the application document', async () => {
  await assertApplicationDocument('/assets/report');
  await assertApplicationDocument('/assets/report/');
});

test('a built bundle is served from the bundle prefix', async () => {
  const response = await get('/assets/entry-abc123.js');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /javascript/);
  assert.equal(await response.text(), bundle);
});

test('an unknown path under the bundle prefix is 404 and never the application document', async () => {
  for (const path of ['/assets/nope.js', '/assets/nope', '/assets/report.js', '/assets/report/nope',
    '/assets/reports', '/assets/', '/assets/nested/report']) {
    const response = await get(path);
    assert.equal(response.status, 404, path);
    assert.notEqual(await response.text(), applicationDocument, path);
  }
  assert.equal((await get('/assets/nope.js', { method: 'POST' })).status, 404);
});

test('middleware placed before the document answers first and may decline', async () => {
  const app = clientBuild(root, async (c, next) => (c.req.path === '/teapot' ? c.text('short and stout', 418) : next()));
  assert.equal((await app.request('/teapot')).status, 418);
  assert.equal(await (await app.request('/lookup')).text(), applicationDocument);
  // The bundle prefix is decided before it, so it cannot turn a missing bundle
  // into a document either.
  assert.equal((await app.request('/assets/nope.js')).status, 404);
});

/** Every address the web client declares, parameters left as written. */
function declaredPaths(entries: RouteConfigEntry[], parent = ''): string[] {
  return entries.flatMap((entry) => {
    const path = entry.path ? `${parent}/${entry.path}` : parent;
    return [...(entry.index || entry.path ? [path || '/'] : []), ...declaredPaths(entry.children ?? [], path)];
  });
}

test('every web route declared under the bundle prefix is served the application document', async () => {
  // A route added under `/assets/` loads by client-side navigation and fails
  // only when its address is typed, reloaded or bookmarked. Such a route must
  // be listed in `applicationRoutesUnderBundlePrefix`, or live elsewhere.
  const underPrefix = declaredPaths(await routes).filter((path) => path === '/assets' || path.startsWith('/assets/'));
  assert.ok(underPrefix.includes('/assets/report'));
  for (const path of underPrefix) await assertApplicationDocument(path);
});
