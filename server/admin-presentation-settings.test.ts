import './dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import Administration from '../web/routes/settings.js';
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
    assert.equal(settings.toastSeconds, defaultToastSeconds);
  } finally { view.stop(); router.dispose(); }
});
