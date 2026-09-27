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
    { ...recorded, key: 'recorded' }, { ...issued, key: 'issued' },
  ], allocation: { value: '061414112', gcp: '0614141', sequence: 12,
    allocatedAt: '2026-01-01T00:00:00Z', allocatedForAssetId: 'asset-id',
    allocatedBy: { key: 'user', name: 'User', status: 'active' } },
  showPolicyVersion: false, canEdit: false, busy: false, onDetach: () => {} }));
  try {
    const cards = [...document.querySelectorAll('li')];
    assert.equal(cards.length, 2);
    assert.match(cards[0].textContent ?? '', /Recorded existing/);
    assert.match(cards[1].textContent ?? '', /Issued by Kannabi/);
    assert.doesNotMatch(view.text(), /GS1 policy/);
  } finally { view.stop(); }
});

test('policy provenance appears only when instance presentation setting enables it', () => {
  const view = mount(createElement(IdentifierList, { identifiers: [{ ...recorded, key: 'recorded' }],
    allocation: null, showPolicyVersion: true, canEdit: false, busy: false, onDetach: () => {} }));
  try {
    assert.match(view.text(), /Recorded existing/);
    assert.ok(view.text().includes('GS1 policy ' + recorded.policyVersion));
  } finally { view.stop(); }
});
