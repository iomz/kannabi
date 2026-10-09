import './dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import Administration, { clientAction as adminSettingsAction } from '../web/routes/settings.js';
import { mount, settle, withTheme } from './dom-render.js';
import { defaultToastSeconds, validateSettings } from './settings.js';

test('instance presentation settings default hidden and render as independent choices', async () => {
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
    const general = [...document.querySelectorAll('h2')].find((heading) => heading.textContent === 'General')
      ?.closest('section');
    assert.ok(general);
    // Each setting is named by a short label; the explanation is not on the
    // page until somebody asks for it.
    assert.deepEqual([...general.querySelectorAll('label')].map((label) => label.textContent?.trim()), [
      'Require asset photo', 'Show Kannabi ID', 'Show identifier policy version', 'Enforce GTIN consistency',
      'Display timezone', 'Maximum API token lifetime (days)', 'Notification duration (seconds)',
    ]);
    assert.equal(general.querySelectorAll('p').length, 0, 'no setting carries a standing helper paragraph');
    assert.doesNotMatch(view.text(), /GS1 Digital Link URIs are unaffected/);
    const helps = ['Require asset photo', 'Show Kannabi ID', 'Show identifier policy version',
      'Enforce GTIN consistency', 'Display timezone', 'Maximum API token lifetime', 'Notification duration'];
    const explanations = [
      /Require a photo when creating an Asset\./,
      /permanent Kannabi UUID and URI\. GS1 Digital Link URIs are unaffected\./,
      /GS1 policy version used to validate each identifier\./,
      /Require GTINs associated with the same Asset to match, including those embedded in SGTINs\./,
      /Choose how timestamps are displayed\. Stored timestamps\s+are unchanged\./,
      /Leave empty to allow tokens without expiration\./,
      /Hovering pauses the timer\. Between 2 and 30\./,
    ];
    for (const [index, name] of helps.entries()) {
      const help = view.button(`About ${name}`);
      assert.ok(help, `${name} has its own info affordance`);
      // Beside the label, never inside it, so the control's name stays the
      // label's words and activating the icon does not toggle the setting.
      assert.equal(help.closest('label'), null);
      assert.equal(help.getAttribute('aria-expanded'), 'false');
      await settle(() => help.click());
      assert.equal(help.getAttribute('aria-expanded'), 'true');
      const popup = [...document.querySelectorAll('[data-slot="popover-content"]')].at(-1);
      assert.ok(popup);
      assert.match(popup.textContent ?? '', explanations[index]);
      // Portalled out of the card, so the card's bounds cannot clip it.
      assert.equal(general.contains(popup), false);
      await settle(() => document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      assert.equal(help.getAttribute('aria-expanded'), 'false');
    }
    // Opening every explanation changed no setting.
    assert.equal(assetId.checked, false);
    assert.equal(policy.checked, false);
    const theme = [...document.querySelectorAll('h2')].filter((heading) => heading.textContent === 'Theme');
    // GTIN consistency is enforced unless an administrator turns it off.
    const consistency = document.querySelector<HTMLInputElement>('input[name="enforceGtinConsistency"]');
    assert.ok(consistency);
    assert.equal(consistency.checked, true);
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
