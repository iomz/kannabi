import './dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AssetCollaboration } from '../web/asset-collaboration.js';
import { createElement } from 'react';
import { mount } from './dom-render.js';

const show = (props: Parameters<typeof AssetCollaboration>[0]) => mount(createElement(AssetCollaboration, props));

const a = { key: 'a', name: 'Workshop' }, b = { key: 'b', name: 'Studio' };
const props = { groups: [a], controlled: [a, b], canEdit: true, canGrant: true,
  busy: false, error: null, onChange: (_key: string, _grant: boolean) => {} };

test('sharing names the receiving Group and passes its unchanged key', () => {
  const changes: unknown[] = [];
  const page = show({ ...props, onChange: (key: string, grant: boolean) => changes.push([key, grant]) });
  try {
    page.click(page.button('Grant Studio collaboration'));
    assert.deepEqual(changes, [['b', true]]);
    assert.equal(page.button('Remove Workshop collaboration')?.disabled, true);
    assert.match(page.text(), /At least one Group must remain/);
  } finally { page.stop(); }
});

test('removal names only a controlled Group and warns of losing access', () => {
  const changes: unknown[] = [];
  const page = show({ ...props, groups: [a, b], controlled: [b], canGrant: false,
    onChange: (key: string, grant: boolean) => changes.push([key, grant]) });
  try {
    assert.equal(page.button('Remove Workshop collaboration'), null);
    page.click(page.button('Remove Studio collaboration'));
    assert.deepEqual(changes, [['b', false]]);
    assert.match(page.text(), /Removal may end your own access/);
  } finally { page.stop(); }
});

test('ordinary members get explanations, public readers get no management controls', () => {
  for (const canEdit of [true, false]) {
    const page = show({ ...props, controlled: [], canGrant: false, canEdit });
    try {
      assert.equal(page.button(/collaboration/), null);
      assert.equal(page.text().includes('Manage collaboration'), canEdit);
    } finally { page.stop(); }
  }
});

test('pending changes disable actions and failed changes announce their error', () => {
  const page = show({ ...props, busy: true, error: 'Group access changed' });
  try {
    assert.equal(page.button('Grant Studio collaboration')?.disabled, true);
    assert.equal(document.querySelector('[role="alert"]')?.textContent, 'Group access changed');
  } finally { page.stop(); }
});
