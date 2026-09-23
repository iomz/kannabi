import './dom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PhotoDeleteConfirmation } from '../web/photo-delete-confirmation.js';

type Props = Parameters<typeof PhotoDeleteConfirmation>[0];

/** Render into a real document, because the dialog lives in a portal and does
 * not exist until it is opened. */
function show(props: Props) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(PhotoDeleteConfirmation, props)); });
  return {
    dialog: () => document.querySelector('[role="alertdialog"], [role="dialog"]'),
    button: (name: string | RegExp) => [...document.querySelectorAll('button')]
      .find((node) => (typeof name === 'string' ? node.textContent?.trim() === name
        : name.test(node.textContent ?? ''))) ?? null,
    stop: () => { act(() => root.unmount()); host.remove(); },
  };
}

const base: Props = { open: true, busy: false, error: null, onClose() {}, onConfirm() {} };

test('nothing is shown until the deletion is actually being asked about', () => {
  const closed = show({ ...base, open: false });
  assert.equal(closed.dialog(), null);
  closed.stop();
});

test('the dialog asks once, names what goes, and is named by its own title', () => {
  const view = show(base);
  const dialog = view.dialog();
  assert.ok(dialog, 'the dialog is present once open');
  const name = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '');
  assert.equal(name?.textContent, 'Delete photo?');
  const description = document.getElementById(dialog.getAttribute('aria-describedby') ?? '');
  assert.match(description?.textContent ?? '', /permanently removed from this Asset/);
  assert.ok(view.button('Cancel'), 'the safe answer is offered');
  assert.ok(view.button('Delete photo'), 'and so is the destructive one');
  view.stop();
});

test('confirming is what calls for the deletion, and closing never does', () => {
  let confirmed = 0;
  let closed = 0;
  const view = show({ ...base, onConfirm: () => { confirmed += 1; }, onClose: () => { closed += 1; } });
  act(() => { view.button('Delete photo')?.click(); });
  assert.equal(confirmed, 1);
  act(() => { view.button('Cancel')?.click(); });
  assert.equal(confirmed, 1, 'cancelling deletes nothing');
  assert.equal(closed, 1);
  view.stop();
});

test('a deletion in flight cannot be asked for twice', () => {
  let confirmed = 0;
  const view = show({ ...base, busy: true, onConfirm: () => { confirmed += 1; } });
  const confirm = view.button(/Deleting/);
  assert.ok(confirm, 'the action says what is happening');
  assert.equal(confirm.disabled, true);
  act(() => { confirm.click(); });
  assert.equal(confirmed, 0);
  view.stop();
});

test('a failure is announced rather than left for the reader to notice', () => {
  const view = show({ ...base, error: 'Storage rejected the delete' });
  const alert = document.querySelector('[role="alert"]');
  // A sentence is punctuated as one, however the failure arrived.
  assert.equal(alert?.textContent, 'Storage rejected the delete.');
  view.stop();
});
