import './dom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { DestructiveConfirmation, deletionCopy } from '../web/destructive-confirmation.js';

type Props = Parameters<typeof DestructiveConfirmation>[0];
const base: Props = {
  open: true, onClose() {}, displayName: 'Hanako', email: 'hanako@example.test',
  mode: 'member', confirmLabel: 'Delete member', fields: { intent: 'delete', key: 'u-1' },
  busy: false, error: null,
};

/** React tracks an input's value, so assigning to it is invisible to the
 * component. Writing through the prototype's own setter is what a keystroke
 * actually does. */
function type(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
    .set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

function show(props: Props) {
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const router = createMemoryRouter(
    [{ path: '*', element: createElement(DestructiveConfirmation, props) }], { initialEntries: ['/'] });
  act(() => { root.render(createElement(RouterProvider, { router })); });
  const text = () => document.querySelector('[role="dialog"]')?.textContent ?? '';
  const button = (name: string) => [...document.querySelectorAll('button')]
    .find((node) => node.textContent?.trim() === name) ?? null;
  return { text, button,
    field: () => document.querySelector<HTMLInputElement>('#deletion-confirmation-email'),
    stop: () => { act(() => root.unmount()); host.remove(); } };
}

test('the explanation comes before the confirmation, not beside it', () => {
  const view = show(base);
  assert.match(view.text(), /Delete “Hanako”/);
  assert.match(view.text(), /removes the personal account, not its recorded provenance/);
  assert.match(view.text(), new RegExp(deletionCopy.member.slice(0, 40)));
  // Nothing can be typed yet: the address is asked for only after the effects
  // have been shown.
  assert.equal(view.field(), null);
  act(() => { view.button('I understand these effects')?.click(); });
  assert.ok(view.field(), 'the address is asked for second');
  assert.match(view.text(), /type “hanako@example\.test” below/);
  view.stop();
});

test('deletion stays refused until the address matches exactly', () => {
  const view = show(base);
  act(() => { view.button('I understand these effects')?.click(); });
  const confirm = () => [...document.querySelectorAll('button')]
    .find((node) => node.textContent?.trim() === 'Delete member') as HTMLButtonElement;
  assert.equal(confirm().disabled, true, 'an empty field deletes nothing');
  const enter = (value: string) => act(() => type(view.field()!, value));
  enter('hanako@example.tes');
  assert.equal(confirm().disabled, true, 'a near miss is still a miss');
  enter('HANAKO@EXAMPLE.TEST');
  assert.equal(confirm().disabled, true, 'and so is the right address in the wrong case');
  enter('hanako@example.test');
  assert.equal(confirm().disabled, false);
  view.stop();
});

test('an account that cannot be deleted says why instead of offering the path', () => {
  const view = show({ ...base, mode: 'account', blocked: true });
  assert.match(view.text(), /final System administrator/);
  assert.match(view.text(), /Promote another member/);
  assert.equal(view.button('I understand these effects'), null);
  assert.equal(view.field(), null);
  view.stop();
});

test('the deletion an account asks about is its own, not somebody else’s', () => {
  const view = show({ ...base, mode: 'account' });
  assert.match(view.text(), /Deleting your account/);
  assert.doesNotMatch(view.text(), /Deleting this member/);
  view.stop();
});

test('the fields that carry the deletion travel with the confirmed form', () => {
  const view = show(base);
  act(() => { view.button('I understand these effects')?.click(); });
  const hidden = [...document.querySelectorAll<HTMLInputElement>('input[type="hidden"]')]
    .map((node) => [node.name, node.value]);
  assert.deepEqual(hidden, [['intent', 'delete'], ['key', 'u-1']]);
  view.stop();
});
