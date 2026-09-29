import './dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { AssetView } from '../web/asset-view.js';
import { mount } from './dom-render.js';
import { newAssetId } from './asset-id.js';
import { canonicalIdentifier } from './gs1.js';

/** What the Asset page puts first.
 *
 * The page is about the Asset's identity, and the identifiers are that
 * identity. Access and provenance are context for them, so the order is
 * asserted here rather than left to whoever edits the render next.
 */

const giai = canonicalIdentifier({ scheme: 'giai', assetReference: '0614141ASSET-1' });
const id = newAssetId();
const loaderData = {
  asset: {
    id, name: 'Inspection camera', isPublic: false, owner: { key: 'o', name: 'Lab' },
    groups: [{ key: 'workshop', name: 'Workshop' }],
    reportedBy: { key: 'alex', name: 'Alex', status: 'active' as const },
    reportedAt: '2026-01-01T00:00:00Z',
    identifiers: [{ key: 'i1', ...giai }], photos: [], issuances: [],
  },
  canEdit: true, canViewReporterProfile: false, authenticated: true,
  settings: { displayTimezone: 'UTC', showAssetId: false, showIdentifierPolicyVersion: false },
  digitalLinks: {}, nativeUri: `http://127.0.0.1/asset/${id}`,
  surfacedUri: `http://127.0.0.1/asset/${id}`,
  namespaces: [], classKeys: [], controlled: [], canGrant: false,
};

function render() {
  const router = createMemoryRouter(
    [{ path: '/asset/:id', element: createElement(AssetView, loaderData as never) }],
    { initialEntries: [`/asset/${id}`] });
  return { view: mount(createElement(RouterProvider, { router })), router };
}

test('identifiers come before the access and provenance detail they are read against', () => {
  const { view, router } = render();
  try {
    const headings = [...document.querySelectorAll('h1, h2')]
      .map((node) => node.textContent?.trim() ?? '');
    const at = (name: string) => headings.indexOf(name);
    assert.ok(at('Inspection camera') >= 0, 'the Asset names itself first');
    assert.ok(at('Identifiers') > at('Inspection camera'));
    // The metadata that used to head the page now follows the identifiers.
    assert.ok(at('Details') > at('Identifiers'),
      `expected Details after Identifiers, got ${headings.join(' | ')}`);
    assert.ok(at('Manage Groups') > at('Identifiers'));
    assert.ok(at('Photos') > at('Identifiers'));
  } finally { view.stop(); router.dispose(); }
});

test('managing Groups is closed until it is asked for, and the Groups stay readable without it', () => {
  const { view, router } = render();
  try {
    const details = [...document.querySelectorAll('details')].find((node) =>
      node.querySelector('summary')?.textContent?.includes('Manage Groups'));
    assert.ok(details, 'Group management is a disclosure rather than an open panel');
    assert.equal(details.open, false, 'closed by default');
    // Which Groups this Asset is associated with is still stated without
    // opening anything: the disclosure hides the act of changing them, not the
    // fact. Details itself is folded, so this reads the term rather than the
    // rendered page text.
    const detailTerms = [...document.querySelectorAll('dt')].map((node) => node.textContent?.trim());
    assert.ok(detailTerms.includes('Groups'));
    assert.match(view.text(), /Workshop/);
  } finally { view.stop(); router.dispose(); }
});

test('the Kannabi ID appears in the detail only when the instance shows it', () => {
  const { view, router } = render();
  try {
    assert.doesNotMatch(view.text(), new RegExp(id));
  } finally { view.stop(); router.dispose(); }

  const shown = createMemoryRouter([{ path: '/asset/:id',
    element: createElement(AssetView, { ...loaderData,
      settings: { ...loaderData.settings, showAssetId: true } } as never) }],
  { initialEntries: [`/asset/${id}`] });
  const second = mount(createElement(RouterProvider, { router: shown }));
  try {
    assert.match(second.text(), new RegExp(id));
  } finally { second.stop(); shown.dispose(); }
});
