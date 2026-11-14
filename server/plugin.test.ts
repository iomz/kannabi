import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import type { Auth } from './auth.js';
import type { HttpEnv } from './http-context.js';
import { createInventoryApi } from './inventory-api.js';
import type { IdentityStore } from './identity-store.js';
import { ValidationError } from './identity.js';
import { compose, connectPlugins, noPlugins, pluginContract, type PluginDefinition } from './plugin.js';
import { composition } from './composition.js';

const manifest = (id: string, extra: Partial<PluginDefinition['manifest']> = {}) => ({
  id, name: id, version: '1.0.0', contract: [pluginContract], requires: [], contributes: [], ...extra });
const plugin = (id: string, extra: Partial<PluginDefinition['manifest']> = {},
  connect: PluginDefinition['connect'] = () => ({ api: id })): PluginDefinition =>
  ({ manifest: manifest(id, extra), connect });

test('Kannabi composed with no plugin is whole', async () => {
  const none = compose([]);
  assert.deepEqual(none.schemes.ids, []);
  const running = connectPlugins(none, {} as IdentityStore);
  assert.deepEqual(running.manifests, []);
  assert.equal(running.claim('/01/04901234567894'), null);
  assert.equal(running.surfaced({ id: 'a', identifiers: [] }), null);
  assert.deepEqual(await running.sections({} as never, null), {});
});

test('composition refuses a plugin it could not run', () => {
  assert.throws(() => compose([plugin('Tag')]), /not a lowercase token/);
  assert.throws(() => compose([plugin('tag'), plugin('tag')]), /installed twice/);
  assert.throws(() => compose([plugin('tag', { contract: [pluginContract + 1] })]), /runs contract/);
  // A peer is an earlier entry, so nothing is handed a plugin not yet built.
  assert.throws(() => compose([plugin('legacy', { requires: ['tag'] }), plugin('tag')]), /requires "tag"/);
});

test('a plugin is handed the peers it named, and only those', () => {
  const seen: Record<string, unknown>[] = [];
  const composed = compose([plugin('tag'), plugin('other'),
    plugin('legacy', { requires: ['tag'] }, (_core, peers) => { seen.push(peers); return { api: null }; })]);
  connectPlugins(composed, {} as IdentityStore);
  assert.deepEqual(seen, [{ tag: 'tag' }]);
});

test('a plugin\'s routes are mounted under its id, behind core\'s authentication and Origin guard', async () => {
  const app = new Hono<HttpEnv>()
    .get('/who', (c) => c.json({ user: c.get('user')?.key ?? null }))
    .post('/change', (c) => c.json({ ok: true }))
    .get('/refuse', () => { throw new ValidationError('Not like that'); })
    .get('/admin/thing', (c) => c.json({ ok: true }));
  const store = { isParticipant: async () => true } as unknown as IdentityStore;
  const session = (token: boolean) => ({ api: { getSession: async () => ({ user: { key: 'alex', name: 'Alex', email: 'a@example.test' },
    session: token ? { id: 't', apiTokenLabel: 'loader', apiTokenAdmin: false } : {} }) } }) as unknown as Auth;
  const origin = 'http://localhost:3000';
  const api = (auth: Auth) => createInventoryApi(store, auth, origin, undefined, undefined, undefined,
    { ...noPlugins, http: [{ id: 'tag', app }] });
  const who = await api(session(false)).request(origin + '/tag/who');
  assert.deepEqual(await who.json(), { user: 'alex' });
  // A cookie-authenticated write without the application's Origin is refused
  // before the plugin sees it.
  assert.equal((await api(session(false)).request(origin + '/tag/change', { method: 'POST' })).status, 403);
  assert.equal((await api(session(false)).request(origin + '/tag/change',
    { method: 'POST', headers: { Origin: origin } })).status, 200);
  // The administrator ceiling on a token applies to a plugin's admin routes.
  assert.equal((await api(session(true)).request(origin + '/tag/admin/thing',
    { headers: { Authorization: 'Bearer secret' } })).status, 403);
  // A plugin's refusal is rendered as core's own are.
  const refusal = await api(session(false)).request(origin + '/tag/refuse');
  assert.equal(refusal.status, 400);
  assert.deepEqual(await refusal.json(), { error: 'Not like that' });
  // An uninstalled plugin leaves no route behind.
  assert.equal((await createInventoryApi(store, session(false), origin).request(origin + '/tag/who')).status, 404);
});

test('the Plugins inventory is an administrator\'s, and only lists', async () => {
  const origin = 'http://localhost:3000';
  const auth = { api: { getSession: async () => ({ user: { key: 'alex', name: 'Alex', email: 'a@example.test' }, session: {} }) } } as unknown as Auth;
  const running = connectPlugins(composition, {} as IdentityStore);
  const as = (admin: boolean) => createInventoryApi(
    { isParticipant: async () => true, isAdministrator: async () => admin } as unknown as IdentityStore,
    auth, origin, undefined, undefined, undefined, running);
  assert.equal((await as(false).request(origin + '/admin/plugins')).status, 403);
  const listed = await (await as(true).request(origin + '/admin/plugins')).json();
  assert.equal(listed.contract, pluginContract);
  assert.deepEqual(listed.plugins.map((entry: { id: string }) => entry.id), ['gs1']);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await as(true).request(origin + '/admin/plugins', { method, headers: { Origin: origin } })).status, 404, method);
  }
});
