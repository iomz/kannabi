import '../../../server/dom.js';

/** What the GS1 plugin's loader hands the Asset page when it has nothing to show. */
const gs1Data = { issuances: [], settings: { enforceGtinConsistency: true }, namespaces: [], classKeys: [] };
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { AssetView } from '../../../web/asset-view.js';
import AssetPage, { clientAction as assetAction } from '../../../web/routes/asset.js';
import { mount, settle } from '../../../server/dom-render.js';
import { newAssetId } from '../../../server/asset-id.js';

/** How the Asset page folds, and how the two things a person can change are
 * reached now that the edit form is gone.
 *
 * The page grows a section per capability, so what starts open is a judgement
 * about what someone came for. These assert the judgement rather than the
 * markup: a `<details>` reports its own state, which is also what assistive
 * technology reads.
 */

const id = newAssetId();
const sourceRecord = {
  reference: 'legacy:asset:1483',
  recordedAt: '2019-04-12T09:30:00.000Z',
  recordedBy: 'A. Rivera',
};

function loaderData(asset: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
  return {
    asset: {
      id, name: 'Inspection camera', isPublic: false, owner: null,
      groups: [{ key: 'workshop', name: 'Workshop' }],
      reportedBy: { key: 'alex', name: 'Alex', status: 'active' as const },
      reportedAt: '2026-09-29T11:00:00.000Z',
      identifiers: [], photos: [], issuances: [], provenance: null, sourceRecord: null, ...asset,
    },
    canEdit: true, canViewReporterProfile: false, authenticated: true,
    settings: { displayTimezone: 'UTC', showAssetId: false, showIdentifierPolicyVersion: false },
    plugins: { gs1: gs1Data }, digitalLinks: {}, nativeUri: `http://127.0.0.1/asset/${id}`,
    surfacedUri: `http://127.0.0.1/asset/${id}`,
    controlled: [], canGrant: false, ...rest,
  };
}

function render(asset: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
  const router = createMemoryRouter(
    [{ path: '/asset/:id', element: createElement(AssetView, loaderData(asset, rest) as never) }],
    { initialEntries: [`/asset/${id}`] });
  return mount(createElement(RouterProvider, { router }));
}

/** A section by its heading, with the disclosure that owns it. */
function section(title: string): HTMLDetailsElement | null {
  for (const summary of document.querySelectorAll('summary')) {
    if (summary.textContent?.trim() === title) return summary.closest('details');
  }
  return null;
}















test('adding an identifier is folded away, and is two tabs before it is a form', async () => {
  const view = render({}, { plugins: { gs1: { ...gs1Data, namespaces: [{ key: 'n', gcp: '0614141' }] } } });
  try {
    const add = [...document.querySelectorAll('summary')]
      .find((node) => node.textContent?.trim() === 'Add identifier')!.closest('details')!;
    assert.equal(add.open, false, 'operations wait until somebody wants to perform one');

    await settle(() => add.querySelector('summary')!.click());
    // Tabs rather than radios beside their own help buttons, which read as
    // four similar round controls.
    const tabs = [...add.querySelectorAll('[role="tab"]')] as HTMLElement[];
    assert.deepEqual(tabs.map((tab) => tab.textContent?.trim()), ['Issue new', 'Record existing']);
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
    assert.equal(add.querySelectorAll('input[type="radio"]').length, 0);

    // One sentence for the active mode, and only its form. Read the live panel
    // rather than the whole section: the inactive mode's name is still on its
    // own tab, so a search across the section would find it either way.
    const panel = () => add.querySelector('[role="tabpanel"]')!;
    assert.match(panel().textContent ?? '', /Issue an identifier under a GS1 Company Prefix namespace/);
    assert.ok(panel().querySelector('button[type="submit"]'), 'issuing is offered');
    assert.ok(panel().querySelector('select[name="scheme"]') === null,
      'recording is not also open');

    await settle(() => tabs[1].click());
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
    assert.match(panel().textContent ?? '', /already been assigned outside Kannabi/);
    assert.ok(!/Issue an identifier under a GS1 Company Prefix/.test(panel().textContent ?? ''),
      'the other mode\u2019s explanation went with its panel');
    assert.ok(panel().querySelector('select[name="scheme"]'), 'recording is offered once chosen');
  } finally { view.stop(); }
});

test('an identifier is not detached until the consequence has been accepted', async () => {
  const gtin = { key: 'i1', scheme: 'gtin' as const, canonical: '(01)00614141123452',
    level: 'class' as const, components: { gtin: '00614141123452' }, policyVersion: 'x' };
  const view = render({ identifiers: [gtin] });
  try {
    assert.match(document.body.textContent ?? '', /Recorded IDs/,
      'identifiers are headed once there are some');
    await settle(() => view.button(/^Detach GTIN/)!.click());
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
    assert.ok(dialog, 'removing an identity asks first');
    assert.match(dialog!.textContent ?? '', /will no longer identify this Asset/);
    assert.ok(view.button('Cancel'), 'and the safe answer is offered');
  } finally { view.stop(); }
});



test('a scheme name points at GS1 rather than at a Kannabi explanation', async () => {
  const sgtin = { key: 'i1', scheme: 'sgtin' as const, canonical: '(01)00614141123452(21)1',
    level: 'individual' as const,
    components: { gtin: '00614141123452', serial: '1' }, policyVersion: 'x' };
  const view = render({ identifiers: [sgtin] });
  try {
    // What an SGTIN is belongs to GS1, so it is a link out, not Kannabi's own
    // help affordance.
    assert.equal(view.button('About SGTIN'), null,
      'a GS1 key definition is not a Kannabi concept');
    const link = [...document.querySelectorAll('a')]
      .find((anchor) => anchor.textContent?.trim() === 'SGTIN')!;
    assert.ok(link, 'the scheme name is the reference');
    // AI 21 is the association that makes a GTIN serialised; AI 01 alone is a
    // GTIN, so this is the AI that distinguishes the scheme.
    assert.equal(link.getAttribute('href'), 'https://ref.gs1.org/ai/21');
    assert.equal(link.getAttribute('target'), '_blank');
    assert.match(link.getAttribute('rel') ?? '', /noopener/);
    assert.match(link.getAttribute('aria-label') ?? '', /GS1 reference/);
    // The one-line orientation stays, stated once.
    const card = link.closest('li')!;
    assert.match(card.textContent ?? '', /Serialised trade item/);
    assert.equal(card.textContent?.match(/identifies this Asset/gi)?.length, 1);
  } finally { view.stop(); }
});
