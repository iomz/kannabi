import './dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import Administration, { clientAction as adminSettingsAction } from '../web/routes/settings.js';
import { mount, settle, withTheme } from './dom-render.js';
import { GtinConflictDialog } from '../web/gtin-conflict-dialog.js';
import { defaultToastSeconds, validateSettings } from './settings.js';

test('instance presentation settings default hidden and render as independent choices', () => {
  const settings = validateSettings({ requirePhoto: false, displayTimezone: 'UTC', themeId: 'default' });
  assert.equal(settings.showAssetId, false);
  assert.equal(settings.showIdentifierPolicyVersion, false);
  const mail = {
    revision: 0, enabled: false, transport: 'smtp' as const, smtpHost: null, smtpPort: null,
    smtpSecurity: null, smtpUsername: null, senderAddress: null, senderName: null,
    verificationStatus: 'not-verified' as const, verificationObservedAt: null,
    passwordState: 'none' as const, operationalState: 'disabled' as const,
    masterKeySource: 'file' as const, masterKeyState: 'available' as const,
  };
  const router = createMemoryRouter([{ path: '/admin/settings', element: withTheme(
    createElement(Administration, { loaderData: { settings, mail } } as never)) }],
  { initialEntries: ['/admin/settings'] });
  const view = mount(createElement(RouterProvider, { router }));
  try {
    const assetId = document.querySelector<HTMLInputElement>('input[name="showAssetId"]');
    const policy = document.querySelector<HTMLInputElement>('input[name="showIdentifierPolicyVersion"]');
    assert.ok(assetId);
    assert.ok(policy);
    assert.equal(assetId.checked, false);
    assert.equal(policy.checked, false);
    assert.ok(view.text().includes('Show Kannabi ID on Asset pages'));
    assert.ok(view.text().includes('Show identifier policy version on Asset pages'));
    assert.ok(view.text().includes('A surfaced GS1 Digital Link URI is unaffected'));
    assert.ok(view.text().includes('Shows Kannabi’s stable UUIDv7 reference for the Asset, and the native Asset URI that spells it.'));
    const general = [...document.querySelectorAll('h2')].find((heading) => heading.textContent === 'General')
      ?.closest('section');
    assert.ok(general);
    assert.deepEqual([...general.querySelectorAll('label')].map((label) => label.textContent?.trim()), [
      'Require photo when reporting an Asset', 'Show Kannabi ID on Asset pages',
      'Show identifier policy version on Asset pages', 'Enforce GTIN consistency',
      'Display timezone',
      'Longest API token lifetime (days)', 'How long a message stays on screen (seconds)',
    ]);
    const theme = [...document.querySelectorAll('h2')].filter((heading) => heading.textContent === 'Theme');
    // GTIN consistency is enforced unless an administrator turns it off.
    const consistency = document.querySelector<HTMLInputElement>('input[name="enforceGtinConsistency"]');
    assert.ok(consistency);
    assert.equal(consistency.checked, true);
    assert.ok(view.text().includes('Require GTINs associated with the same Asset to match, including those embedded in SGTINs.'));
    assert.equal(theme.length, 1, 'Theme has one visible card heading');
    assert.ok(theme[0].closest('section')?.className.includes('max-w-3xl'));
    assert.equal(settings.toastSeconds, defaultToastSeconds);
  } finally { view.stop(); router.dispose(); }
});

test('saving either presentation setting preserves the configured toast lifetime', async () => {
  const originalFetch = globalThis.fetch;
  const sent: Record<string, unknown>[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push(body);
    return new Response(JSON.stringify({ settings: { ...body, toastSeconds: 12 } }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const data = new FormData();
  for (const [name, value] of Object.entries({ intent: 'settings', displayTimezone: 'UTC', themeId: 'default',
    apiTokenMaxLifetimeDays: '', toastSeconds: '12', showAssetId: 'on', showIdentifierPolicyVersion: '' })) {
    data.set(name, value);
  }
  try {
    const result = await adminSettingsAction({ request: new Request('https://kannabi.test/admin/settings', {
      method: 'POST', body: data,
    }) } as never);
    assert.equal((result as { saved: boolean }).saved, true);
    assert.equal(sent[0].toastSeconds, 12);
    assert.equal(sent[0].showAssetId, true);
    assert.equal(sent[0].showIdentifierPolicyVersion, false);
  } finally { globalThis.fetch = originalFetch; }
});

test('the GTIN consistency switch saves its own state and nothing else', async () => {
  const originalFetch = globalThis.fetch;
  const sent: Record<string, unknown>[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push(body);
    return new Response(JSON.stringify({ settings: body }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    for (const value of ['', 'on']) {
      const data = new FormData();
      for (const [name, field] of Object.entries({ intent: 'settings', displayTimezone: 'UTC', themeId: 'default',
        apiTokenMaxLifetimeDays: '', toastSeconds: '5', enforceGtinConsistency: value })) {
        data.set(name, field);
      }
      await adminSettingsAction({ request: new Request('https://kannabi.test/admin/settings', {
        method: 'POST', body: data,
      }) } as never);
    }
    assert.deepEqual(sent.map((body) => body.enforceGtinConsistency), [false, true]);
  } finally { globalThis.fetch = originalFetch; }
});

test('a refused GTIN consistency switch hands back the Assets that block it', async () => {
  const originalFetch = globalThis.fetch;
  const gtinConflicts = { total: 2, hidden: 1, next: null,
    assets: [{ id: '01a1208f-8ce3-7523-9947-cd187ada00d1', name: 'Bench camera' }] };
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'GTIN consistency cannot be enabled while Assets carry conflicting GTINs', gtinConflicts,
  }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  const data = new FormData();
  for (const [name, value] of Object.entries({ intent: 'settings', displayTimezone: 'UTC', themeId: 'default',
    apiTokenMaxLifetimeDays: '', toastSeconds: '5', enforceGtinConsistency: 'on' })) data.set(name, value);
  try {
    const result = await adminSettingsAction({ request: new Request('https://kannabi.test/admin/settings', {
      method: 'POST', body: data,
    }) } as never) as { saved: boolean; gtinConflicts?: unknown };
    assert.equal(result.saved, false);
    assert.deepEqual(result.gtinConflicts, gtinConflicts);
  } finally { globalThis.fetch = originalFetch; }
});

test('the GTIN conflict dialog names the readable Assets, counts the rest and has one OK', async () => {
  const originalFetch = globalThis.fetch;
  const originalObserver = globalThis.IntersectionObserver;
  const asked: string[] = [];
  globalThis.fetch = async (input) => {
    asked.push(String(input));
    return new Response(JSON.stringify({ gtinConflicts: { total: 3, hidden: 1, next: null,
      assets: [{ id: '01a1208f-8ce3-7523-9947-cd187ada00d3', name: 'Third' }] } }),
    { headers: { 'Content-Type': 'application/json' } });
  };
  // The list pages as it is scrolled to its end, as the inventory does; this
  // stands in for the browser reporting that the end came into view.
  const watching: (() => void)[] = [];
  globalThis.IntersectionObserver = class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe() { watching.push(() => this.callback([{ isIntersecting: true }] as never, this as never)); }
    disconnect() {}
  } as never;
  let closed = 0;
  const conflicts = { total: 3, hidden: 1, next: '01a1208f-8ce3-7523-9947-cd187ada00d2',
    assets: [{ id: '01a1208f-8ce3-7523-9947-cd187ada00d1', name: 'First' },
      { id: '01a1208f-8ce3-7523-9947-cd187ada00d2', name: 'Second' }] };
  const router = createMemoryRouter([{ path: '/', element: createElement(GtinConflictDialog,
    { conflicts, onClose: () => { closed += 1; } }) }], { initialEntries: ['/'] });
  const view = mount(createElement(RouterProvider, { router }));
  try {
    await settle();
    assert.equal(view.dialogName(), 'Cannot enable GTIN consistency');
    assert.match(view.text(), /3 Assets have conflicting GTINs\. Resolve these conflicts before enabling\s+this setting\./);
    const links = () => [...document.querySelectorAll('[role="alertdialog"] a')]
      .map((link) => [link.textContent, link.getAttribute('href')]);
    assert.deepEqual(links(), [['First', '/asset/01a1208f-8ce3-7523-9947-cd187ada00d1'],
      ['Second', '/asset/01a1208f-8ce3-7523-9947-cd187ada00d2']]);
    assert.match(view.text(), /1 more is in Groups you do not belong to/);
    // The refusal is the dialog's description, and the Assets to act on stand
    // apart from it.
    const description = document.getElementById(view.dialog()!.getAttribute('aria-describedby') ?? '');
    assert.match(description?.textContent ?? '', /^3 Assets have conflicting GTINs\./);
    assert.equal(description!.querySelector('a'), null);
    const buttons = () => [...view.dialog()!.querySelectorAll('button')].map((button) => button.textContent?.trim());
    assert.deepEqual(buttons(), ['OK'], 'one acknowledgement and nothing else');

    assert.equal(asked.length, 0, 'nothing more is read until the list end is reached');
    await settle(() => watching.at(-1)!());
    await settle();
    assert.match(asked[0], /\/api\/admin\/gtin-conflicts\?after=01a1208f-8ce3-7523-9947-cd187ada00d2/);
    assert.deepEqual(links().map(([name]) => name), ['First', 'Second', 'Third']);
    assert.deepEqual(buttons(), ['OK'], 'paging adds no button');

    await settle(() => view.button('OK')!.click());
    assert.equal(closed, 1, 'OK closes the dialog and does nothing else');
    assert.equal(asked.length, 1, 'closing sends nothing');
  } finally {
    view.stop(); router.dispose(); globalThis.fetch = originalFetch;
    globalThis.IntersectionObserver = originalObserver;
  }
});
