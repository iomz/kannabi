import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReporterAttribution } from '../web/reporter-attribution.js';

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
