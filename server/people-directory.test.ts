import './dom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import People from '../web/routes/people.js';
import { mount } from './dom-render.js';

const colleague = {
  key: 'colleague', name: 'Colleague', avatarHash: null, reportedAssets: 3, self: false,
  email: 'colleague@example.test',
  sharedGroups: [{ key: 'workshop', name: 'Workshop' }, { key: 'studio', name: 'Studio' }],
};

function show(loaderData: object) {
  const router = createMemoryRouter([{ path: '*', element: createElement(People, { loaderData } as never) }],
    { initialEntries: ['/people'] });
  return { view: mount(createElement(RouterProvider, { router })), router };
}

test('one card per person, with the address and shared Groups the server sent', () => {
  const { view, router } = show({ people: [colleague], more: false, q: '', directory: 'everyone' });
  try {
    const card = document.querySelector<HTMLAnchorElement>('a[href="/users/colleague"]')!;
    assert.match(card.textContent!, /colleague@example\.test/);
    assert.match(card.textContent!, /3 Assets reported by this person that you can read/);
    assert.match(card.textContent!, /Shared Groups: WorkshopStudio/);
    assert.equal(document.querySelectorAll('a[href="/users/colleague"]').length, 1,
      'several shared Groups stay in one card');
    assert.ok(document.querySelector('[role="search"] input[name="q"]'), 'the directory is searchable');
    assert.equal(view.text().includes('More people match'), false);
  } finally { view.stop(); router.dispose(); }
});

test('the directory says what it covers, says when to narrow, and shows nothing it was not sent', () => {
  const nameOnly = { ...colleague, email: null };
  const { view, router } = show({ people: [nameOnly], more: true, q: 'col', directory: 'names' });
  try {
    assert.match(view.text(), /Everybody taking part in this instance/);
    assert.equal(document.querySelector('a[href^="mailto:"]'), null);
    assert.doesNotMatch(view.text(), /@/);
    assert.match(view.text(), /More people match than are shown/);
    assert.equal(document.querySelector<HTMLInputElement>('input[name="q"]')!.value, 'col');
  } finally { view.stop(); router.dispose(); }
  const shared = show({ people: [], more: false, q: 'zed', directory: 'shared' });
  try {
    assert.match(shared.view.text(), /People you share a Group with/);
    assert.match(shared.view.text(), /Nobody you can find matches “zed”/);
  } finally { shared.view.stop(); shared.router.dispose(); }
});
