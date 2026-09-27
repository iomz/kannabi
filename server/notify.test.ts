import './dom';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { Toaster } from '../web/components/ui/sonner.js';
import { notify, notifyFailure } from '../web/notify.js';
import { defaultToastSeconds, maxToastSeconds, minToastSeconds } from './settings.js';
import { mount, settle, withTheme } from './dom-render.js';

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

test('a message reaches one viewport for the whole application', async () => {
  const view = await raise(() => notify('Photo deleted'));
  const region = document.querySelector('[data-sonner-toaster]');
  assert.ok(region, 'there is a viewport');
  assert.match(view.text(), /Photo deleted/);
  await settle(() => notify('Identifier detached'));
  assert.equal(document.querySelectorAll('[data-sonner-toaster]').length, 1, 'still one viewport');
  assert.match(view.text(), /Identifier detached/);
  view.stop();
});

test('a failure is distinguished from a confirmation, not just coloured', async () => {
  const view = await raise(() => notifyFailure('The token could not be revoked'));
  // The kind is in the data, so the icon and assistive technology read the
  // same thing rather than colour being the only signal.
  assert.equal(toast()?.getAttribute('data-type'), 'error');
  view.stop();

  const confirmation = await raise(() => notify('Photo deleted'));
  assert.equal(toast()?.getAttribute('data-type'), 'success');
  confirmation.stop();
});

test('only the mark carries the kind; the message and the surface do not', () => {
  // A whole toast in danger colours is louder than the news usually is, so the
  // text and the surface stay in the theme's ordinary colours and the icon
  // beside them is where success and failure are told apart.
  const component = readFileSync('web/components/ui/sonner.tsx', 'utf8');
  assert.match(component, /success: <CircleCheckIcon className="size-4 text-success-text" \/>/);
  assert.match(component, /error: <OctagonXIcon className="size-4 text-danger-text" \/>/);
  assert.match(component, /"--success-text": "var\(--kannabi-text\)"/);
  assert.match(component, /"--error-text": "var\(--kannabi-text\)"/);
});

test('a message can be dismissed before its time is up', async () => {
  const view = await raise(() => notify('Photo deleted'));
  const close = document.querySelector<HTMLElement>('[data-close-button]');
  assert.ok(close, 'dismissal is offered');
  view.stop();
});

test('the remaining-time bar is the toast’s own lifetime', async () => {
  // The instance decides how long a toast lives, and the bar is given the same
  // number rather than a duration of its own.
  const view = await raise(() => notify('Photo deleted'), 9);
  const viewport = document.querySelector<HTMLElement>('[data-sonner-toaster]');
  assert.equal(viewport?.style.getPropertyValue('--kannabi-toast-duration'), '9s');
  view.stop();

  // A caller that needs longer than the instance's policy sets both the timer
  // and the bar, because disagreeing about them is the bug this prevents.
  const longer = await raise(() => notify('Photo deleted', { seconds: 12 }));
  assert.equal(toast()?.style.getPropertyValue('--kannabi-toast-duration'), '12s');
  longer.stop();
});

test('the bar stops when Sonner stops, and keeps running when reduced motion is asked for', () => {
  // Sonner pauses while `expanded || interacting || isDocumentHidden`. Only
  // the first has an attribute; the second cannot happen without it; the third
  // is the browser's, mirrored onto the document by the shell.
  assert.match(stylesheet, /\[data-sonner-toast\]\[data-expanded="true"\]::after/);
  assert.match(stylesheet, /\[data-kannabi-document-hidden="true"\] \[data-sonner-toast\]::after/);
  assert.match(stylesheet, /animation-play-state: paused/);
  const root = readFileSync('web/root.tsx', 'utf8');
  assert.match(root, /kannabiDocumentHidden = String\(document\.hidden\)/);
  // The countdown is the only thing saying when the toast disappears, so it is
  // information rather than decoration and is never reduced away.
  assert.doesNotMatch(stylesheet, /motion-reduce[^\n]*kannabi-toast-lifetime/);
});

test('the instance decides how long a toast lives, within a readable range', () => {
  assert.equal(defaultToastSeconds, 5, 'the shipped lifetime is unchanged');
  assert.equal(minToastSeconds, 2);
  assert.equal(maxToastSeconds, 30);
});

test('transient mutation acknowledgements use Sonner while durable and validation feedback stays in context', () => {
  for (const path of ['web/routes/asset.tsx', 'web/routes/groups.tsx', 'web/routes/settings.tsx',
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
  for (const path of ['web/routes/asset.tsx', 'web/routes/groups.tsx', 'web/routes/settings.tsx',
    'web/routes/admin-users.tsx', 'web/routes/settings-profile.tsx', 'web/routes/settings-security.tsx',
    'web/routes/report.tsx', 'web/routes/signin.tsx', 'web/appearance-selector.tsx', 'web/avatar-preference.tsx',
    'web/asset-collaboration.tsx', 'web/asset-identifiers.tsx', 'web/profile-editor.tsx']) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /TransientSuccess/,
      `${path} does not render a parallel timed acknowledgement system`);
  }
});
