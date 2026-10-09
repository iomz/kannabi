import './dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { IdentifierList, IssueIdentifier } from '../web/asset-identifiers.js';
import { mount, settle } from './dom-render.js';
import { canonicalIdentifier } from './gs1.js';

/** What the identifier cards and the issuance controls put in front of a
 * person, read back from a real document. */

const gtin = canonicalIdentifier({ scheme: 'gtin', gtin: '0614141123452' });
const giai = canonicalIdentifier({ scheme: 'giai', assetReference: '0614141ASSET-1' });

function list(props: Partial<Parameters<typeof IdentifierList>[0]> = {}) {
  return mount(createElement(IdentifierList, {
    identifiers: [{ ...gtin, key: 'class', attachment: null }, { ...giai, key: 'individual', attachment: null }],
    issuances: [], digitalLinks: {}, showPolicyVersion: false,
    canEdit: false, busy: false, onDetach: () => {}, ...props,
  }));
}

test('an identifier card carries scheme, value and provenance, and nothing that reads as a sentence beside them', () => {
  const view = list();
  try {
    // Provenance stays on the card: it is the fact a reader scans for.
    assert.match(view.text(), /Recorded existing/);
    // The level explanation does not sit beside it, where two statements of
    // different kinds ran together into one phrase.
    assert.doesNotMatch(view.text(), /Describes a class this Asset belongs to/);
    assert.doesNotMatch(view.text(), /Identifies this Asset/);
    // The scheme and the value are both still there.
    assert.match(view.text(), /GTIN/);
    assert.match(view.text(), /\(01\)00614141123452/);
  } finally { view.stop(); }
});

test('a scheme name is a reference to GS1, not a Kannabi explanation', () => {
  const view = list();
  try {
    // What a GS1 key is belongs to GS1. Kannabi's own help affordance is for
    // Kannabi concepts, and wearing it here would claim the definition.
    assert.equal(view.button('About GTIN'), null);
    const link = [...document.querySelectorAll('a')]
      .find((anchor) => anchor.textContent?.trim() === 'GTIN')!;
    assert.ok(link, 'the name is the reference');
    // AI 01 is the GTIN's own Application Identifier.
    assert.equal(link.getAttribute('href'), 'https://ref.gs1.org/ai/01');
    assert.match(link.getAttribute('aria-label') ?? '', /GS1 reference/);
    // The orientation line stays beside it, once.
    assert.match(view.text(), /Trade item — describes what this Asset is/);
  } finally { view.stop(); }
});

test('an issuance highlights the value it just produced, where the reader was looking', () => {
  const issuance = {
    key: 'issuance', scheme: 'giai' as const, canonical: giai.canonical, gcp: '0614141',
    sequence: 5, classKeyCanonical: null, allocatedAt: '2026-01-01T00:00:00Z',
    allocatedForAssetId: 'asset', allocatedBy: { key: 'u', name: 'U', status: 'active' as const },
  };
  const view = list({ issuances: [issuance], justIssued: giai.canonical });
  try {
    assert.match(view.text(), /Issued by Kannabi/);
    // The card for the new value is marked; the other one is not. Asserted by
    // counting marked cards rather than by pinning the class that marks them.
    const highlighted = [...document.querySelectorAll('li')]
      .filter((node) => node.className.includes('animate-arrival'));
    assert.equal(highlighted.length, 1);
    assert.match(highlighted[0].textContent ?? '', /0614141ASSET-1/);
  } finally { view.stop(); }
});

test('issuance controls point a first-time reader at the thing they are missing', () => {
  const show = (props: Parameters<typeof IssueIdentifier>[0]) => {
    const router = createMemoryRouter([{ path: '/', element: createElement(IssueIdentifier, props) }],
      { initialEntries: ['/'] });
    return { view: mount(createElement(RouterProvider, { router })), router };
  };
  // A managed class key is the prerequisite for a serial, and the control says
  // where one comes from instead of leaving the reader to discover Groups.
  const { view, router } = show({
    namespaces: [{ key: 'ns', gcp: '0614141' }], classKeys: [],
    issuances: [{ key: 'i', scheme: 'giai', canonical: giai.canonical, gcp: '0614141',
      sequence: 1, classKeyCanonical: null, allocatedAt: '2026-01-01T00:00:00Z',
      allocatedForAssetId: 'a', allocatedBy: { key: 'u', name: 'U', status: 'active' } }],
    identifiers: [{ ...giai, key: 'individual', attachment: null }], busy: false, error: null,
  });
  try {
    assert.match(view.text(), /issued under a managed class key/);
    const link = document.querySelector('a[href="/groups"]');
    assert.ok(link, 'the prerequisite is reachable rather than merely named');
    assert.match(link.textContent ?? '', /class key/);
  } finally { view.stop(); router.dispose(); }
});
