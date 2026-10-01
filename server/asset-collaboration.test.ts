import './dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AssetCollaboration } from '../web/asset-collaboration.js';
import { createElement } from 'react';
import { mount, settle } from './dom-render.js';

/** Associating a Group with an Asset gives its members read and edit access,
 * and removing one can take that away — including from the person doing it.
 * Neither happens on a single click any more, so what is asserted here is the
 * decision a person is actually asked to make, and the key that reaches the
 * mutation unchanged.
 */

const show = (props: Parameters<typeof AssetCollaboration>[0]) =>
  mount(createElement(AssetCollaboration, props));

const a = { key: 'a', name: 'Workshop' }, b = { key: 'b', name: 'Studio' };
const c = { key: 'c', name: 'Field Kits' };
const props = { groups: [a], controlled: [a, b], canEdit: true, canGrant: true,
  busy: false, error: null, onChange: (_key: string, _grant: boolean) => {} };

const dialog = () => document.querySelector('[role="alertdialog"], [role="dialog"]');

test('one eligible Group is still chosen explicitly before it is confirmed', async () => {
  const changes: unknown[] = [];
  const page = show({ ...props, onChange: (key: string, grant: boolean) => changes.push([key, grant]) });
  try {
    // One row per association, and one affordance for adding another — not a
    // button per eligible Group.
    assert.match(page.text(), /Workshop/);
    await settle(() => page.click(page.button('Associate another Group')));

    // Deliberately not skipped for a single candidate: the step says which
    // Group is being picked and which others were eligible.
    assert.match(dialog()?.textContent ?? '', /Choose Group/);
    const choice = page.field('select') as unknown as HTMLSelectElement;
    assert.ok(choice, 'the candidate is selected rather than assumed');
    assert.deepEqual([...choice.options].map((option) => option.textContent), ['Studio']);
    assert.deepEqual(changes, [], 'nothing has happened yet');

    await settle(() => page.click(page.button('Continue')));
    const confirm = dialog();
    assert.match(confirm!.textContent ?? '', /Associate Studio with this Asset\?/);
    assert.match(confirm!.textContent ?? '', /Members of Studio will be able to read and edit/);
    assert.deepEqual(changes, [], 'and still nothing until it is confirmed');

    await settle(() => page.click(page.button('Associate')));
    assert.deepEqual(changes, [['b', true]]);
  } finally { page.stop(); }
});

test('cancelling an association changes nothing', async () => {
  const changes: unknown[] = [];
  const page = show({ ...props, onChange: (key: string, grant: boolean) => changes.push([key, grant]) });
  try {
    await settle(() => page.click(page.button('Associate another Group')));
    await settle(() => page.click(page.button('Cancel')));
    assert.deepEqual(changes, []);
  } finally { page.stop(); }
});

test('several eligible Groups are chosen from before the consequence is stated', async () => {
  const changes: unknown[] = [];
  const page = show({ ...props, controlled: [a, b, c],
    onChange: (key: string, grant: boolean) => changes.push([key, grant]) });
  try {
    await settle(() => page.click(page.button('Associate another Group')));
    const choice = page.field('select') as unknown as HTMLSelectElement;
    assert.ok(choice, 'a choice is offered rather than one button per Group');
    assert.deepEqual([...choice.options].map((option) => option.textContent),
      ['Studio', 'Field Kits'], 'only Groups not already associated');

    await settle(() => {
      choice.value = 'c';
      choice.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle(() => page.click(page.button('Continue')));
    assert.match(dialog()?.textContent ?? '', /Associate Field Kits with this Asset\?/);
    await settle(() => page.click(page.button('Associate')));
    assert.deepEqual(changes, [['c', true]]);
  } finally { page.stop(); }
});

test('removal is offered only for a controlled Group, and states what is lost', async () => {
  const changes: unknown[] = [];
  const page = show({ ...props, groups: [a, b], controlled: [b], canGrant: false,
    onChange: (key: string, grant: boolean) => changes.push([key, grant]) });
  try {
    assert.equal(page.button('Remove Workshop'), null, 'a Group this person does not control');
    await settle(() => page.click(page.button('Remove Studio')));
    assert.match(dialog()?.textContent ?? '', /Remove Studio from this Asset\?/);
    assert.match(dialog()?.textContent ?? '', /will lose access/);
    assert.match(dialog()?.textContent ?? '', /may end your own access/);
    assert.deepEqual(changes, [], 'nothing has happened yet');

    await settle(() => page.click(page.button('Remove')));
    assert.deepEqual(changes, [['b', false]]);
  } finally { page.stop(); }
});

test('the last association cannot be removed, and the control says why', () => {
  const page = show(props);
  try {
    const only = page.button(/^Cannot remove Workshop/);
    assert.ok(only, 'the reason is in the accessible name, not only in the disabled state');
    assert.equal(only!.disabled, true);
    assert.match(only!.getAttribute('aria-label') ?? '', /an Asset keeps at least one Group/);
  } finally { page.stop(); }
});

test('a reader who cannot edit is shown no Group management at all', () => {
  const page = show({ ...props, canEdit: false });
  try {
    assert.equal(page.text().includes('Manage Groups'), false);
  } finally { page.stop(); }
});

test('a member who controls nothing sees the associations without the acts', () => {
  const page = show({ ...props, controlled: [], canGrant: false });
  try {
    assert.match(page.text(), /Manage Groups/);
    assert.match(page.text(), /Workshop/);
    assert.equal(page.button(/^Remove/), null);
    assert.equal(page.button('Associate another Group'), null);
  } finally { page.stop(); }
});

test('no title-level help, and one sentence inside instead', () => {
  const page = show(props);
  try {
    // Every other top-level section title is a plain word; this one had the
    // only help button beside it.
    assert.equal(page.button(/^About Group/), null);
    assert.match(page.text(), /Associated Groups can read and edit this Asset/);
    // The rows say what they are, so the column header said nothing.
    assert.equal(document.querySelector('thead'), null);
    assert.match(page.text(), /Associated/);
  } finally { page.stop(); }
});

test('somebody eligible to associate nothing is told so rather than shown an empty menu', async () => {
  const page = show({ ...props, groups: [a, b], controlled: [a, b] });
  try {
    await settle(() => page.click(page.button('Associate another Group')));
    assert.match(dialog()?.textContent ?? '', /You control no Group that is not already associated/);
    assert.equal(page.field('select'), null);
    assert.equal(page.button('Continue')?.disabled, true);
  } finally { page.stop(); }
});

test('pending changes disable the acts and a failed change announces its error', () => {
  const page = show({ ...props, busy: true, error: 'Group access changed' });
  try {
    assert.equal(page.button('Associate another Group')?.disabled, true);
    assert.equal(document.querySelector('[role="alert"]')?.textContent, 'Group access changed');
  } finally { page.stop(); }
});
