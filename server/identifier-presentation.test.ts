import './dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { IdentifierList } from '../web/asset-identifiers.js';
import { mount } from './dom-render.js';
import { canonicalIdentifier } from './gs1.js';

const recorded = canonicalIdentifier({ scheme: 'giai', assetReference: '024' });
const issued = canonicalIdentifier({ scheme: 'giai', assetReference: '061414112' });

test('identifier cards show issuance provenance only for ledger-matched GIAI and hide policy stamp by default', () => {
  const view = mount(createElement(IdentifierList, { identifiers: [
    { ...recorded, key: 'recorded', attachment: null }, { ...issued, key: 'issued', attachment: null },
  ], issuances: [{ key: 'issuance', scheme: 'giai', canonical: issued.canonical, gcp: '0614141',
    sequence: 12, classKeyCanonical: null,
    allocatedAt: '2026-01-01T00:00:00Z', allocatedForAssetId: 'asset-id',
    allocatedBy: { key: 'user', name: 'User', status: 'active' } }],
  digitalLinks: {}, showPolicyVersion: false, canEdit: false, busy: false, onDetach: () => {} }));
  try {
    const cards = [...document.querySelectorAll('li')];
    assert.equal(cards.length, 2);
    assert.match(cards[0].textContent ?? '', /Recorded existing/);
    assert.match(cards[1].textContent ?? '', /Issued by Kannabi/);
    assert.doesNotMatch(view.text(), /GS1 policy/);
  } finally { view.stop(); }
});

test('policy provenance appears only when instance presentation setting enables it', () => {
  const view = mount(createElement(IdentifierList, { identifiers: [{ ...recorded, key: 'recorded', attachment: null }],
    issuances: [], digitalLinks: {}, showPolicyVersion: true, canEdit: false, busy: false, onDetach: () => {} }));
  try {
    assert.match(view.text(), /Recorded existing/);
    assert.ok(view.text().includes('GS1 policy ' + recorded.policyVersion));
  } finally { view.stop(); }
});

test('a Digital Link appears only on identifiers Kannabi also dereferences', () => {
  const gtin = canonicalIdentifier({ scheme: 'gtin', gtin: '0614141123452' });
  const sgtin = canonicalIdentifier({ scheme: 'sgtin', gtin: '0614141123452', serial: 'aB/c%D' });
  const view = mount(createElement(IdentifierList, { identifiers: [
    { ...gtin, key: 'class', attachment: null }, { ...sgtin, key: 'individual', attachment: null },
  ], issuances: [],
  // The class-level GTIN deliberately has none: its URI is constructible and
  // Kannabi answers it with 404, so offering the link would be a dead end.
  digitalLinks: { individual: 'https://kannabi.example/01/00614141123452/21/aB%2Fc%25D' },
  showPolicyVersion: false, canEdit: false, busy: false, onDetach: () => {} }));
  try {
    // Scheme names are now links to GS1's own reference, so narrow to the
    // Digital Link rather than counting every anchor on the card.
    const links = [...document.querySelectorAll('a')]
      .filter((anchor) => !anchor.href.startsWith('https://ref.gs1.org/'));
    assert.equal(links.length, 1);
    // The accessible name is the URI itself, which distinguishes the cards.
    assert.equal(links[0].textContent, 'https://kannabi.example/01/00614141123452/21/aB%2Fc%25D');
    assert.equal(links[0].getAttribute('href'), 'https://kannabi.example/01/00614141123452/21/aB%2Fc%25D');
    // The serial's slash stayed encoded, so following the link resolves the
    // identifier rather than a truncated one.
    assert.doesNotMatch(links[0].getAttribute('href') ?? '', /21\/aB\/c/);
    const cards = [...document.querySelectorAll('li')];
    assert.doesNotMatch(cards[0].textContent ?? '', /Digital Link/);
    assert.match(cards[1].textContent ?? '', /GS1 Digital Link/);
  } finally { view.stop(); }
});

test('each identifier says who accepted it and on what basis, and claims nothing when unknown', () => {
  const attachment = {
    acceptedBy: { key: 'user', name: 'Alex', status: 'active' as const },
    acceptedAt: '2026-01-01T00:00:00.000Z',
    assertedBy: { id: 'token', label: 'Depot loader' }, basis: 'depot:assetcats:42',
  };
  const view = mount(createElement(IdentifierList, { identifiers: [
    { ...recorded, key: 'recorded', attachment }, { ...issued, key: 'issued', attachment: null },
  ], issuances: [], digitalLinks: {}, showPolicyVersion: false, canEdit: false, busy: false,
  displayTimezone: 'UTC', onDetach: () => {} }));
  try {
    const cards = [...document.querySelectorAll('li')];
    assert.match(cards[0].textContent ?? '', /Accepted by Alex via Depot loader/);
    assert.match(cards[0].textContent ?? '', /basis depot:assetcats:42/);
    assert.doesNotMatch(cards[1].textContent ?? '', /Accepted by/);
  } finally { view.stop(); }
});
