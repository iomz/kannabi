import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { ReporterAttribution } from '../web/reporter-attribution.js';

function render(props: Parameters<typeof ReporterAttribution>[0]) {
  const router = createMemoryRouter([{ path: '*', element: createElement(ReporterAttribution, props) }]);
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

test('reporter attribution distinguishes deleted provenance from an active member', () => {
  const active = renderToStaticMarkup(createElement(ReporterAttribution, {
    reporter: { key: 'active', name: 'Active Member', status: 'active' },
  }));
  assert.match(active, />Active Member</);
  assert.doesNotMatch(active, /Deleted member/);

  const deleted = renderToStaticMarkup(createElement(ReporterAttribution, {
    reporter: { key: 'deleted', name: 'David Test', status: 'deleted' },
  }));
  assert.match(deleted, />David Test</);
  // Marked as its own thing beside the name, rather than folded into it.
  assert.match(deleted, /data-slot="badge"[^>]*>Deleted member</);
  // A tombstone is not a discoverable User, so nothing here links anywhere.
  assert.doesNotMatch(deleted, /href=/);
});

test('reporter attribution links only after Workspace profile authorization', () => {
  const reporter = { key: 'active', name: 'Active User', status: 'active' as const };
  const unreachable = render({ reporter, link: false });
  assert.match(unreachable, />Active User</);
  assert.doesNotMatch(unreachable, /href=/);

  const reachable = render({ reporter, link: true });
  assert.match(reachable, /href="\/users\/active"/);
});
