import './dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { AssetView } from '../web/asset-view.js';
import { mount } from './dom-render.js';
import { newAssetId } from './asset-id.js';

/** How a reader is kept from mistaking quoted evidence for Kannabi's record.
 *
 * The two facts sit one above the other on the page and look alike: a date and
 * a person. What distinguishes them is only ever whose statement they are, so
 * that distinction is asserted here rather than left to whoever edits the
 * render next.
 */

const id = newAssetId();
const sourceRecord = {
  reference: 'legacy:asset:1483',
  recordedAt: '2019-04-12T09:30:00.000Z',
  recordedBy: 'A. Rivera',
  description: null as string | null,
};

function loaderData(overrides: Record<string, unknown> = {}) {
  return {
    asset: {
      id, name: 'Inspection camera', isPublic: false, owner: null,
      groups: [{ key: 'workshop', name: 'Workshop' }],
      reportedBy: { key: 'alex', name: 'Alex', status: 'active' as const },
      reportedAt: '2026-09-29T11:00:00.000Z',
      identifiers: [], photos: [], issuances: [], provenance: null,
      sourceRecord: null, ...overrides,
    },
    canEdit: false, canViewReporterProfile: false, authenticated: true,
    settings: { displayTimezone: 'UTC', showAssetId: false, showIdentifierPolicyVersion: false },
    digitalLinks: {}, nativeUri: `http://127.0.0.1/asset/${id}`,
    surfacedUri: `http://127.0.0.1/asset/${id}`,
    namespaces: [], classKeys: [], controlled: [], canGrant: false,
  };
}

function render(overrides: Record<string, unknown> = {}) {
  const router = createMemoryRouter(
    [{ path: '/asset/:id', element: createElement(AssetView, loaderData(overrides) as never) }],
    { initialEntries: [`/asset/${id}`] });
  return mount(createElement(RouterProvider, { router }));
}

const headings = () => [...document.querySelectorAll('h1, h2')].map((n) => n.textContent?.trim() ?? '');

/** The list a term belongs to, so two facts in two lists cannot be asserted as
 * though they sat together. */
function definitionOf(term: string): { list: Element; value: string } | null {
  for (const dt of document.querySelectorAll('dt')) {
    if (dt.textContent?.trim() !== term) continue;
    const dd = dt.nextElementSibling;
    return { list: dt.closest('dl')!, value: dd?.textContent?.trim() ?? '' };
  }
  return null;
}

test('an Asset that originated in Kannabi says nothing about a source', () => {
  const view = render();
  try {
    assert.ok(!headings().includes('Source record'), 'no empty section appears');
    assert.equal(definitionOf('Source reference'), null);
    assert.ok(definitionOf('Reported'), 'Kannabi’s own reporting is unaffected');
  } finally { view.stop(); }
});

test('quoted source evidence never shares a description list with Kannabi’s reporting', () => {
  const view = render({ sourceRecord });
  try {
    const reported = definitionOf('Reported');
    const stated = definitionOf('Source states recorded');
    assert.ok(reported && stated);
    assert.notEqual(reported!.list, stated!.list,
      'the source’s own time must not sit in the row group that means Kannabi');
    assert.ok(headings().includes('Source record'), 'it is a section of its own');
  } finally { view.stop(); }
});

test('every quoted fact names whose statement it is', () => {
  const view = render({ sourceRecord });
  try {
    assert.match(definitionOf('Source states recorded')!.value, /2019/);
    assert.equal(definitionOf('Source states recorded by')!.value, 'A. Rivera');
    assert.equal(definitionOf('Source reference')!.value, 'legacy:asset:1483');
    // The recorder is not offered as somebody to visit: a profile link would
    // imply a Kannabi account that a quoted name never has.
    const panel = [...document.querySelectorAll('section')]
      .find((s) => s.querySelector('h2')?.textContent?.trim() === 'Source record')!;
    assert.equal(panel.querySelectorAll('a').length, 0, 'a quoted name resolves to nobody');
    assert.match(panel.textContent ?? '', /states this — not that it is true/,
      'the panel says what Kannabi is and is not claiming');
  } finally { view.stop(); }
});

test('a source that stated no time or no recorder says so rather than borrowing Kannabi’s', () => {
  const view = render({ sourceRecord: { reference: 'legacy:asset:9', recordedAt: null, recordedBy: null } });
  try {
    assert.equal(definitionOf('Source states recorded')!.value, 'Not stated by the source');
    assert.equal(definitionOf('Source states recorded by')!.value, 'Not stated by the source');
    // Kannabi's own reporting stays visible and stays separate.
    assert.match(definitionOf('Reported')!.value, /Alex/);
  } finally { view.stop(); }
});

test('a quoted description is shown exactly, as a quotation, and absence claims nothing', () => {
  const description = 'Bench camera\r\nS/N 0042\n  funding <code>';
  const view = render({ sourceRecord: { ...sourceRecord, description } });
  try {
    const stated = definitionOf('Source states description');
    assert.ok(stated, 'labelled as the source’s statement');
    assert.notEqual(stated!.list, definitionOf('Reported')!.list);
    const quote = stated!.list.querySelector('blockquote');
    assert.ok(quote, 'set off as a quotation');
    assert.equal(quote!.textContent, description, 'line breaks and spacing are kept');
  } finally { view.stop(); }
  const absent = render({ sourceRecord });
  try {
    assert.equal(definitionOf('Source states description'), null,
      'no description recorded is not rendered as the source having none');
  } finally { absent.stop(); }
});
