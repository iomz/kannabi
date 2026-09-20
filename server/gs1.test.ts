import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertAiAssociations, assertCompatible, assertReversibleSchemes, canonicalGtin, canonicalIdentifier,
  canonicalIdentifiers, gs1Policy, identifierSchemes, schemeInputs, storedIdentifier,
} from './gs1.js';
import { entries, enforcedLinters, syntaxDictionaryRelease, unenforcedLinters } from './gs1-syntax.js';
import { ValidationError } from './identity.js';

const sgtin = { scheme: 'sgtin', gtin: '0614141123452', serial: '001a/A%' } as const;
const grai = { scheme: 'grai', assetType: '0614141234561', serial: '789' } as const;
const giai = { scheme: 'giai', assetReference: '0614141ASSET-001' } as const;

test('GS1 policy is versioned independently and never misattributes its GenSpec mapping', () => {
  assert.equal(gs1Policy.syntaxDictionaryRelease, syntaxDictionaryRelease);
  assert.equal(gs1Policy.version, `${syntaxDictionaryRelease}+kannabi.1`);
  // GS1 does not publish this mapping, so Kannabi must own it explicitly.
  assert.equal(gs1Policy.assertedBy, 'kannabi');
  assert.match(gs1Policy.generalSpecificationsRelease, /^\d+\.\d+$/);
  assert.notEqual(gs1Policy.version, gs1Policy.generalSpecificationsRelease);
  // Linters Kannabi cannot perform are declared rather than silently skipped.
  assert.deepEqual([...enforcedLinters], ['csum', 'zero']);
  for (const linter of ['gcppos1', 'gcppos2']) assert.match(unenforcedLinters[linter], /GCP|gcppos1/);
});

test('GTIN-8, UPC, JAN and GTIN-14 normalize to 14 digits without numeric conversion', () => {
  for (const [input, expected] of [
    ['96385074', '00000096385074'],
    ['036000291452', '00036000291452'],
    ['4901234567894', '04901234567894'],
    ['10614141123459', '10614141123459'],
  ]) assert.equal(canonicalGtin(input), expected);
  for (const input of ['4901234567895', '123', ' 96385074', '96385074\n', 96385074]) {
    assert.throws(() => canonicalGtin(input), ValidationError);
  }
});

test('each scheme derives its own canonical form, components and level', () => {
  const cases = [
    [{ scheme: 'gtin', gtin: '0614141123452' }, '(01)00614141123452', 'class'],
    [sgtin, '(01)00614141123452(21)001a/A%', 'individual'],
    [{ scheme: 'grai', assetType: '0614141234561' }, '(8003)00614141234561', 'class'],
    [grai, '(8003)00614141234561789', 'individual'],
    [giai, '(8004)0614141ASSET-001', 'individual'],
  ] as const;
  for (const [input, canonical, level] of cases) {
    const identifier = canonicalIdentifier(input);
    assert.equal(identifier.canonical, canonical);
    assert.equal(identifier.level, level);
    assert.equal(identifier.policyVersion, gs1Policy.version);
    // Round-tripping through storage must reproduce components and level exactly.
    const restored = storedIdentifier(identifier.scheme, identifier.canonical, identifier.policyVersion);
    assert.deepEqual(restored.components, identifier.components);
    assert.equal(restored.level, identifier.level);
  }
});

test('a GRAI is class-level without a serial and individual with one', () => {
  assert.equal(canonicalIdentifier({ scheme: 'grai', assetType: '0614141234561' }).level, 'class');
  assert.equal(canonicalIdentifier({ ...grai, serial: '' }).level, 'class');
  assert.equal(canonicalIdentifier(grai).level, 'individual');
  assert.deepEqual(canonicalIdentifier(grai).components, { assetType: '0614141234561', serial: '789' });
});

test('component constraints follow the pinned Syntax Dictionary specification', () => {
  assert.equal(entries['8003'].spec, 'N1,zero N13,csum,gcppos1 [X..16]');
  assert.equal(entries['8004'].spec, 'X..30,gcppos1');
  // AI 8003 asset type: 13 digits with a valid check digit.
  for (const assetType of ['0614141234562', '061414123456', '06141412345612', '061414123456A']) {
    assert.throws(() => canonicalIdentifier({ scheme: 'grai', assetType }), ValidationError);
  }
  // Serial character set and length, per CSET 82 and the component maxima.
  for (const serial of ['', ' ', 'A\n', '日本', '#', '$', '@', 'A'.repeat(21)]) {
    assert.throws(() => canonicalIdentifier({ ...sgtin, serial }), ValidationError);
  }
  assert.throws(() => canonicalIdentifier({ ...grai, serial: 'A'.repeat(17) }), ValidationError);
  assert.doesNotThrow(() => canonicalIdentifier({ ...grai, serial: 'A'.repeat(16) }));
  for (const assetReference of ['', 'A'.repeat(31), '日本']) {
    assert.throws(() => canonicalIdentifier({ scheme: 'giai', assetReference }), ValidationError);
  }
  assert.doesNotThrow(() => canonicalIdentifier({ scheme: 'giai', assetReference: 'A'.repeat(30) }));
});

test('unsupported schemes, extra fields and encoded forms are not silently accepted', () => {
  for (const value of [null, [], {}, 'urn:epc:id:sgtin:0614141.012345.1',
    { scheme: 'manufacturer', serial: '123' }, { scheme: 'gtin', gtin: '0614141123452', serial: 'x' },
    { ...sgtin, assetType: '0614141234561' }, { ...giai, publicId: '123' },
    { scheme: 'sgtin', gtin: '0614141123452' }, { scheme: 'giai' }]) {
    assert.throws(() => canonicalIdentifier(value), ValidationError);
  }
});

test('an Asset may carry several identifiers, including SGTIN with GIAI', () => {
  const identifiers = canonicalIdentifiers([sgtin, giai, { scheme: 'gtin', gtin: '0614141123452' }]);
  assert.deepEqual(identifiers.map((identifier) => identifier.scheme), ['sgtin', 'giai', 'gtin']);
  assert.deepEqual(canonicalIdentifiers(undefined), []);
  assert.deepEqual(canonicalIdentifiers([]), []);
  assert.throws(() => canonicalIdentifiers({} as never), ValidationError);
});

test('GS1 req= and ex= are evaluated within one identifier, never across an Asset', () => {
  // Identifier scope: the AIs of one element string. AI 21 requires AI 01.
  assert.throws(() => assertAiAssociations(['21']), ValidationError);
  assert.doesNotThrow(() => assertAiAssociations(['01', '21']));
  assert.doesNotThrow(() => assertAiAssociations(['8003']));
  assert.doesNotThrow(() => assertAiAssociations(['8004']));
  // The dictionary does carry exclusions, so the rules are live, not inert.
  assert.ok(entries['01'].excludes?.length);
  assert.ok(entries['21'].requires?.length);

  // Asset scope: independent identifiers attached to one Asset are not one
  // carrier payload, so their AIs are never unioned and association-checked.
  // A manufacturer's SGTIN beside an owner-assigned GIAI stays valid.
  assert.doesNotThrow(() => canonicalIdentifiers([sgtin, giai]));
  assert.doesNotThrow(() => canonicalIdentifiers([grai, giai]));
  assert.doesNotThrow(() => canonicalIdentifiers([sgtin, giai, { scheme: 'gtin', gtin: '0614141123452' }]));
  // Every pair of supported schemes combines, apart from Kannabi's own rules.
  // Reintroducing Asset-level AI association checking would break this.
  for (const first of identifierSchemes) {
    for (const second of identifierSchemes) {
      if (first === second) continue;
      const build = { gtin: { scheme: 'gtin', gtin: '0614141123452' }, sgtin, grai, giai } as const;
      const pair = [build[first], build[second]];
      if (new Set(pair.map((one) => JSON.stringify(one))).size < 2) continue;
      assert.doesNotThrow(() => canonicalIdentifiers(pair), `${first} + ${second}`);
    }
  }
});

test('Kannabi Asset-level identifier rules stay separate from GS1 syntax', () => {
  // The same identifier twice.
  assert.throws(() => canonicalIdentifiers([sgtin, sgtin]), ValidationError);
  // Two different AI (01) values: an Asset is an instance of one trade item.
  assert.throws(() => canonicalIdentifiers([sgtin, { scheme: 'gtin', gtin: '4901234567894' }]), ValidationError);
  assert.throws(() => canonicalIdentifiers([sgtin, { ...sgtin, gtin: '4901234567894' }]), ValidationError);
  // A matching GTIN alongside its SGTIN is consistent.
  assert.doesNotThrow(() => canonicalIdentifiers([sgtin, { scheme: 'gtin', gtin: '00614141123452' }]));
  assert.doesNotThrow(() => assertCompatible([canonicalIdentifier(sgtin)]));
  assert.doesNotThrow(() => assertCompatible([]));
});

test('every supported scheme has a reversible canonical form', () => {
  // Only the final rendered component may vary in length, or parsing a stored
  // canonical back into components would be ambiguous.
  assert.doesNotThrow(assertReversibleSchemes);
  // Adversarial values: a serial may legally contain CSET 82 parentheses and
  // even a literal AI prefix, which positional parsing must survive.
  for (const value of [
    { ...sgtin, serial: '(21)ABC' },
    { ...sgtin, serial: '((()))' },
    { ...sgtin, serial: '0'.repeat(20) },
    { ...grai, serial: '(8003)0' },
    { scheme: 'giai', assetReference: '(8004)(01)12345' },
    { scheme: 'giai', assetReference: 'A'.repeat(30) },
  ] as const) {
    const identifier = canonicalIdentifier(value);
    const restored = storedIdentifier(identifier.scheme, identifier.canonical, identifier.policyVersion);
    assert.deepEqual(restored.components, identifier.components, identifier.canonical);
    assert.equal(restored.level, identifier.level);
    assert.equal(restored.canonical, identifier.canonical);
  }
});

test('a stored identifier must carry the policy version that accepted it', () => {
  const identifier = canonicalIdentifier(sgtin);
  for (const stamp of [undefined, null, '', 42]) {
    assert.throws(() => storedIdentifier(identifier.scheme, identifier.canonical, stamp), ValidationError);
  }
  // A stamp from an older policy is preserved, never rewritten to the active one.
  const historical = storedIdentifier(identifier.scheme, identifier.canonical, '2024-06-10+kannabi.1');
  assert.equal(historical.policyVersion, '2024-06-10+kannabi.1');
  assert.notEqual(historical.policyVersion, gs1Policy.version);
});

test('rendering descriptors cover every supported scheme without restating validation', () => {
  for (const scheme of identifierSchemes) {
    assert.ok(schemeInputs[scheme].length > 0, scheme);
    for (const input of schemeInputs[scheme]) assert.ok(input.label && input.name);
  }
  assert.deepEqual(schemeInputs.grai.map((input) => input.required), [true, false]);
});
