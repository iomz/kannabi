import './dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import Administration, { clientAction as adminSettingsAction } from '../web/routes/settings.js';
import { mount, withTheme } from './dom-render.js';
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
    assert.ok(view.text().includes('Show native Asset ID on Asset pages'));
    assert.ok(view.text().includes('Show identifier policy version on Asset pages'));
    assert.ok(view.text().includes('The Asset URI remains available independently.'));
    assert.ok([...document.querySelectorAll('h2')].some((heading) => heading.textContent === 'General'));
    assert.ok([...document.querySelectorAll('h2')].some((heading) => heading.textContent === 'Theme'));
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
