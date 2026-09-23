import './dom';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { Toaster } from '../web/components/ui/toast.js';
import { notify, notifyFailure } from '../web/notify.js';
import { mount } from './dom-render.js';

/** The viewport has to be listening before anything is raised, which is the
 * same order the application has: the shell mounts, then something happens. */
function raise(run: () => void) {
  const view = mount(createElement(Toaster, { timeout: 5000 }));
  act(() => run());
  return view;
}

test('a message reaches one viewport for the whole application', () => {
  const view = raise(() => notify('Photo deleted'));
  const region = document.querySelector('[data-slot="toast-viewport"]');
  assert.ok(region, 'there is a viewport');
  assert.equal(region.getAttribute('aria-live'), 'polite', 'announced without interrupting');
  assert.equal(region.getAttribute('aria-label'), 'Notifications');
  assert.match(view.text(), /Photo deleted/);
  // One viewport, however many messages.
  act(() => { notify('Identifier detached'); });
  assert.equal(document.querySelectorAll('[data-slot="toast-viewport"]').length, 1);
  assert.match(view.text(), /Identifier detached/);
  view.stop();
});

test('a failure is distinguished from a confirmation, not just coloured', () => {
  const view = raise(() => notifyFailure('The token could not be revoked'));
  const toast = document.querySelector('[data-slot="toast"]');
  assert.ok(toast, 'the message is present');
  // The type is carried in the data, so assistive technology and the icon both
  // read the same thing rather than the colour being the only signal.
  assert.match(view.html(), /data-type="error"/);
  view.stop();
});

test('a message can be dismissed before its time is up', () => {
  const view = raise(() => notify('Photo deleted'));
  const close = document.querySelector<HTMLElement>('[data-slot="toast-close"]');
  assert.ok(close, 'dismissal is offered');
  assert.equal(close.getAttribute('aria-label'), 'Close toast');
  view.stop();
});

test('the viewport sits at the top right and yields to reduced motion', () => {
  // Placement and motion are decisions, not defaults: the component ships
  // bottom-anchored and animates in either way.
  const source = readFileSync('web/components/ui/toast.tsx', 'utf8');
  assert.match(source, /fixed inset-x-4 top-4/);
  assert.match(source, /sm:right-4 sm:left-auto/);
  assert.doesNotMatch(source, /fixed inset-x-4 bottom-4/);
  assert.match(source, /motion-reduce:\[transform:none\]/);
  assert.match(source, /motion-reduce:data-starting-style:\[transform:none\]/);
});

test('feedback stays beside its control wherever the control is still there', () => {
  // The rule the audit settled on: a toast is for when what was acted on has
  // gone. A `Saved` beside the button that saved is easier to connect than a
  // message in the corner, so those stay inline.
  const settings = readFileSync('web/routes/settings.tsx', 'utf8');
  assert.match(settings, /<TransientSuccess[^>]*label="Saved"/);
  assert.doesNotMatch(settings, /\bnotify\(/);

  const asset = readFileSync('web/routes/asset.tsx', 'utf8');
  // Uploading leaves the form on screen; deleting leaves nothing behind.
  assert.match(asset, /<TransientSuccess[^>]*label="Uploaded"/);
  assert.match(asset, /notify\('Photo deleted'\)/);
  assert.match(asset, /notify\('Identifier detached'\)/);
  assert.doesNotMatch(asset, /label="Deleted"/);
  assert.doesNotMatch(asset, /label="Detached"/);
});
