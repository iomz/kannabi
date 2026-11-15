import '../../../server/dom';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { Toaster } from '../../../web/components/ui/sonner.js';
import { notify, notifyFailure } from '../../../web/notify.js';
import { defaultToastSeconds, maxToastSeconds, minToastSeconds } from '../../../server/settings.js';
import { mount, settle, withTheme } from '../../../server/dom-render.js';

const stylesheet = readFileSync('web/style.css', 'utf8');

/** The viewport has to be listening before anything is raised, which is the
 * same order the application has: the shell mounts, then something happens.
 * Sonner reaches its subscribers asynchronously, so the flush is awaited. */
async function raise(run: () => void, seconds = defaultToastSeconds) {
  const view = mount(withTheme(createElement(Toaster, { seconds })));
  await settle(run);
  return view;
}

const toast = () => document.querySelector<HTMLElement>('[data-sonner-toast]');









test('transient mutation acknowledgements use Sonner while durable and validation feedback stays in context', () => {
  // The Asset view is shared by the native and Digital Link routes, so the
  // acknowledgements it owns live beside it rather than in either route.
  for (const path of ['web/asset-view.tsx', 'web/routes/groups.tsx', 'web/routes/settings.tsx',
    'web/routes/admin-users.tsx', 'web/routes/settings-profile.tsx', 'web/routes/settings-security.tsx',
    'web/routes/report.tsx', 'web/routes/signin.tsx', 'web/appearance-selector.tsx',
    'web/avatar-preference.tsx', 'web/root.tsx']) {
    const source = readFileSync(path, 'utf8');
    assert.match(source, /notify\(/, `${path} routes transient confirmation through Sonner`);
    assert.doesNotMatch(source, /<TransientSuccess/, `${path} has no inline transient success replacement`);
  }
  assert.match(readFileSync('web/appearance-selector.tsx', 'utf8'), /notifyFailure\(/,
    'appearance persistence failure uses Sonner');
  assert.match(readFileSync('web/avatar-preference.tsx', 'utf8'), /notifyFailure\(/,
    'avatar preference failure uses Sonner');

  const tokens = readFileSync('web/api-tokens.tsx', 'utf8');
  assert.match(tokens, /notify\(/, 'token revocation is transient');
  assert.match(tokens, /IssuedSecretDialog/, 'one-time token secret remains in its durable dialog');
  assert.match(tokens, /error && <p role="alert"/, 'validation and operation errors remain beside their dialog controls');
  const report = readFileSync('web/routes/report.tsx', 'utf8');
  assert.match(report, /actionData\?\.error && <p role="alert"/, 'report errors remain beside the form');
  const settings = readFileSync('web/routes/settings.tsx', 'utf8');
  assert.match(settings, /testResult\?\.error && <p role="alert"/, 'mail delivery diagnostics remain revisit-able inline');
  assert.match(readFileSync('web/root.tsx', 'utf8'), /actionData\?\.error/,
    'sign-out failure remains visible in the shell');
  for (const path of ['web/asset-view.tsx', 'web/routes/asset.tsx', 'plugins/gs1/web/digital-link.tsx',
    'web/routes/groups.tsx', 'web/routes/settings.tsx',
    'web/routes/admin-users.tsx', 'web/routes/settings-profile.tsx', 'web/routes/settings-security.tsx',
    'web/routes/report.tsx', 'web/routes/signin.tsx', 'web/appearance-selector.tsx', 'web/avatar-preference.tsx',
    'web/asset-collaboration.tsx', 'web/asset-identifiers.tsx', 'web/profile-editor.tsx']) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /TransientSuccess/,
      `${path} does not render a parallel timed acknowledgement system`);
  }
});
