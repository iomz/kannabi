import './dom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import Members from '../web/routes/members.js';
import { mount } from './dom-render.js';

test('one User card shows every shared Group supplied for that viewer', () => {
  const members = [{
    key: 'colleague', name: 'Colleague', avatarHash: null, reportedAssets: 3, self: false,
    sharedGroups: [{ key: 'workshop', name: 'Workshop' }, { key: 'studio', name: 'Studio' }],
  }];
  const router = createMemoryRouter([{
    path: '*', element: createElement(Members, { loaderData: { members } } as never),
  }], { initialEntries: ['/members'] });
  const view = mount(createElement(RouterProvider, { router }));

  const colleague = document.querySelector<HTMLAnchorElement>('a[href="/users/colleague"]');
  assert.ok(colleague);
  assert.match(colleague.textContent ?? '', /3 Assets you can read/);
  assert.match(colleague.textContent ?? '', /Shared Groups: WorkshopStudio/);
  assert.equal(document.querySelectorAll('a[href="/users/colleague"]').length, 1,
    'multiple shared Groups stay in one User card');

  assert.equal(document.querySelectorAll('a').length, 1,
    'only Group-derived members supplied by the endpoint are rendered');
  view.stop();
});
