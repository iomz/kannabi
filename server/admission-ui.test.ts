import './dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import Users, { clientAction as usersAction } from '../web/routes/admin-users.js';
import { defaultSettings } from './settings.js';
import { AwaitingApproval, awaitsApproval } from '../web/awaiting-approval.js';
import { mount, settle } from './dom-render.js';

const account = (key: string, name: string, approvedAt: string | null) => ({ key, name,
  email: `${key}@example.test`, isAdmin: false, credentialState: 'established' as const,
  createdAt: '2026-10-01T00:00:00.000Z', approvedAt });

function open(calls: { path: string; method: string }[]) {
  globalThis.fetch = async (input, init) => {
    calls.push({ path: new URL(String(input), 'https://kannabi.test').pathname, method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ changed: true, deleted: true }), { headers: { 'Content-Type': 'application/json' } });
  };
  const router = createMemoryRouter([{ path: '/admin/users',
    element: createElement(Users, { loaderData: { settings: defaultSettings, actorKey: 'admin',
      users: [account('admin', 'Admin', '2026-10-01T00:00:00.000Z'), account('waiting', 'Waiting Applicant', null)] } } as never),
    action: (args) => usersAction(args as never) }], { initialEntries: ['/admin/users'] });
  return { view: mount(createElement(RouterProvider, { router })), router };
}

test('an administrator approves or rejects a waiting account from Users, and rejecting is confirmed', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls: { path: string; method: string }[] = [];
  const { view, router } = open(calls);
  try {
    const queue = document.querySelector('section[aria-labelledby="approvals-heading"]')!;
    assert.match(queue.textContent!, /Waiting for approval/);
    assert.match(queue.textContent!, /Email addresses are not verified/);
    assert.match(queue.textContent!, /Waiting Applicant/);
    assert.doesNotMatch(queue.textContent!, /Admin@|admin@example/, 'only waiting accounts are queued');
    const row = [...document.querySelectorAll('tbody tr')].find((node) => node.textContent!.includes('Waiting Applicant'))!;
    assert.match(row.textContent!, /Waiting for approval/);

    await settle(() => view.button('Approve Waiting Applicant')!.click());
    await settle();
    assert.deepEqual(calls.at(-1), { path: '/api/admin/users/waiting/approval', method: 'POST' });

    view.click(view.button('Reject Waiting Applicant'));
    await settle();
    assert.equal(view.dialogName(), 'Reject Waiting Applicant?');
    assert.match(view.dialog()!.textContent!, /Their account is deleted/);
    const before = calls.length;
    view.click([...view.dialog()!.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!);
    await settle();
    assert.equal(calls.length, before, 'cancel changes nothing');
    view.click(view.button('Reject Waiting Applicant'));
    await settle();
    await settle(() => [...view.dialog()!.querySelectorAll('button')].find((button) => button.textContent === 'Reject')!.click());
    await settle();
    assert.deepEqual(calls.at(-1), { path: '/api/admin/users/waiting', method: 'DELETE' });
  } finally { view.stop(); router.dispose(); }
});

test('a signed-in account that waits is told so everywhere but its settings and public pages', () => {
  const at = (pathname: string, extra: object = {}) => awaitsApproval({ signedIn: true, approved: false,
    publicContent: false, pathname, ...extra });
  assert.equal(at('/groups'), true);
  assert.equal(at('/'), true);
  assert.equal(at('/settings'), false, 'its own account');
  assert.equal(at('/settings/security'), false);
  assert.equal(at('/asset/x', { publicContent: true }), false, 'public pages read as anybody may');
  assert.equal(at('/groups', { approved: true }), false);
  assert.equal(at('/groups', { signedIn: false }), false, 'a visitor is the anonymous shell’s concern');
  const router = createMemoryRouter([{ path: '/', element: createElement(AwaitingApproval, { name: 'Waiting Applicant' }) }]);
  const view = mount(createElement(RouterProvider, { router }));
  try {
    assert.match(view.text(), /Waiting for approval/);
    assert.match(view.text(), /Thanks, Waiting Applicant/);
    assert.equal(document.querySelector('a[href="/settings"]')?.textContent, 'account settings');
    assert.ok(view.button('Sign out'));
  } finally { view.stop(); router.dispose(); }
});

test('the waiting screen asks again on request, so approval changes the shell without a reload', async () => {
  let loads = 0;
  const router = createMemoryRouter([{ path: '/', loader: () => ++loads,
    element: createElement(AwaitingApproval, { name: 'Waiting Applicant' }) }]);
  const view = mount(createElement(RouterProvider, { router }));
  try {
    await settle();
    const before = loads;
    await settle(() => view.button('Check again')!.click());
    await settle();
    assert.equal(loads, before + 1, 'asking again re-reads the account');
  } finally { view.stop(); router.dispose(); }
});

test('a waiting account reads a public Asset as a visitor does, asking for no Groups or namespaces', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const asked: string[] = [];
  globalThis.fetch = async (input) => {
    const path = new URL(String(input), 'https://kannabi.test').pathname;
    asked.push(path);
    const body = path === '/api/me' ? { user: { key: 'waiting', name: 'Waiting', email: 'w@example.test' }, approved: false }
      : path === '/api/settings' ? { settings: defaultSettings }
        : path.startsWith('/api/assets/') ? { asset: { id: 'a', name: 'Public rig', isPublic: true, groups: [], identifiers: [] },
          canEdit: false } : null;
    return new Response(JSON.stringify(body), { status: body ? 200 : 401, headers: { 'Content-Type': 'application/json' } });
  };
  const { loadAsset } = await import('../web/asset-view.js');
  const loaded = await loadAsset('a', new Request('https://kannabi.test/asset/a'));
  assert.equal(loaded.asset.name, 'Public rig');
  assert.equal(loaded.authenticated, false, 'no workspace chrome for an account that takes no part yet');
  assert.deepEqual(asked.filter((path) => path === '/api/groups' || path === '/api/gs1-namespaces'), []);
});
