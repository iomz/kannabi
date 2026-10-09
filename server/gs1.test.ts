import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adoptableClassKey, allocatedGiai, allocatedGraiAssetType, allocatedGraiSerial, allocatedGtin,
  allocatedGtinFormat, allocatedSgtin, assertAiAssociations, assertAttachable, assertCompatible,
  assertReversibleSchemes, canIssueClassKey, canonicalGcp, canonicalGtin, canonicalIdentifier,
  canonicalIdentifiers, classKeyConflictReason, classKeyWithinGcp, gcpRefusalReason, gs1Policy,
  hasGtinConflict, identifierSchemes, schemeInputs,
  storedIdentifier,
} from './gs1.js';
import {
  checkDigit, entries, enforcedLinters, syntaxDictionaryRelease, unenforcedLinters,
} from './gs1-syntax.js';
import { ValidationError } from './identity.js';

const sgtin = { scheme: 'sgtin', gtin: '0614141123452', serial: '001a/A%' } as const;
const grai = { scheme: 'grai', assetType: '0614141234561', serial: '789' } as const;
const giai = { scheme: 'giai', assetReference: '0614141ASSET-001' } as const;

test('GS1 policy is versioned independently and never misattributes its GenSpec mapping', () => {
  assert.equal(gs1Policy.syntaxDictionaryRelease, syntaxDictionaryRelease);
  // The overlay gained Digital Link derivation while the pinned release did
  // not change, which is exactly the case the suffix exists to record.
  assert.equal(gs1Policy.version, `${syntaxDictionaryRelease}+kannabi.3`);
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

test('an allocated GIAI is built from a configured prefix and a numeric reference', () => {
  const identifier = allocatedGiai('0614141', 12);
  assert.equal(identifier.components.assetReference, '061414112');
  assert.equal(identifier.canonical, '(8004)061414112');
  assert.equal(identifier.level, 'individual');
  assert.equal(identifier.scheme, 'giai');
  assert.equal(identifier.policyVersion, gs1Policy.version);
  // Unpadded decimal, so ordering is the stored sequence and never the string.
  assert.equal(allocatedGiai('0614141', 5).components.assetReference, '06141415');
  assert.equal(allocatedGiai('0614141', 1_000_000).components.assetReference, '06141411000000');
  for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, '4']) {
    assert.throws(() => allocatedGiai('0614141', sequence as number), ValidationError, String(sequence));
  }
});

test('a configured prefix is validated against published rules, never a GCP Length Table', () => {
  // General Specifications 26.0 §1.2.3.3: four to twelve digits. Publishing
  // that range is not the same as being able to locate a prefix boundary
  // inside an arbitrary key, which is what the unpublished GCP Length Table
  // answers — so the range is enforced and `gcppos` stays unenforced.
  for (const gcp of ['0614', '0614141', '9'.repeat(12)]) assert.equal(canonicalGcp(gcp), gcp);
  for (const gcp of ['', '06141A1', '0614141 ', '061', '9'.repeat(13), 614141, null]) {
    assert.throws(() => canonicalGcp(gcp), ValidationError, String(gcp));
  }
  // §1.2.2.2.1: an RCN SHALL NOT be encoded using any GS1 Application
  // Identifier, and every value Kannabi issues is an AI element string, so
  // restricted-circulation prefix space can never be a managed namespace.
  for (const gcp of ['0000000', '0212345', '0412345', '2012345', '2912345', '0000050']) {
    assert.throws(() => canonicalGcp(gcp), ValidationError, gcp);
  }
  // A prefix shorter than a restricted range still reaches into it: every key
  // issued from `0000` extends it into the seven-digit ranges below, so the
  // comparison spans what the extensions could cover rather than an
  // equal-length slice.
  for (const gcp of ['0000', '00000', '000000']) {
    assert.throws(() => canonicalGcp(gcp), ValidationError, gcp);
  }
  // Its neighbours that do issue company prefixes are untouched.
  for (const gcp of ['00001234', '0001234', '0019999']) {
    assert.equal(canonicalGcp(gcp), gcp);
  }
  // 952 is GS1's own demonstration and example range, so it stays usable.
  assert.equal(canonicalGcp('9521234'), '9521234');
});

test('a prefix an earlier policy accepted is reported, not repaired or hidden', () => {
  // Configuring one is refused outright; reading one configured before these
  // rules must still say what is wrong rather than throw, so a deployment
  // holding one keeps starting and keeps its ledger readable.
  assert.equal(gcpRefusalReason('0614141'), null);
  assert.match(gcpRefusalReason('0455123')!, /Restricted Circulation Numbers/);
  assert.match(gcpRefusalReason('061')!, /4 to 12 digits/);
  assert.match(gcpRefusalReason('9'.repeat(20))!, /4 to 12 digits/);
  assert.match(gcpRefusalReason('06141A1')!, /string of digits/);
  // The two agree: whatever one refuses, the other refuses with that reason.
  for (const gcp of ['0455123', '061', '06141A1']) {
    assert.throws(() => canonicalGcp(gcp), (error: Error) =>
      error instanceof ValidationError && error.message === gcpRefusalReason(gcp));
  }
});

test('a prefix too long for a class reference stays valid for GIAI', () => {
  // Capability, never validity: a twelve-digit prefix leaves no room for the
  // twelve digits a GTIN or a GRAI asset type needs before its check digit.
  assert.equal(canIssueClassKey('95212345678'), true);
  assert.equal(canIssueClassKey('952123456789'), false);
  assert.equal(canonicalGcp('952123456789'), '952123456789');
  assert.doesNotThrow(() => allocatedGiai('952123456789', 1));
  assert.throws(() => allocatedGtin('952123456789', 1), ValidationError);
  assert.throws(() => allocatedGraiAssetType('952123456789', 1), ValidationError);
});

test('a class reference is padded to the prefix and carries its own check digit', () => {
  // The arithmetic a GRAI asset type and a base GTIN genuinely share, applied
  // twice under two names rather than through one generic key builder.
  const type = allocatedGraiAssetType('0614141', 42);
  const gtin = allocatedGtin('0614141', 42);
  assert.equal(type.components.assetType, '0614141000425');
  assert.equal(type.canonical, '(8003)00614141000425');
  assert.equal(type.level, 'class');
  assert.equal(gtin.components.gtin, '00614141000425');
  assert.equal(gtin.level, 'class');
  // §2.3: the same digits under AI 01 and AI 8003 are two different keys, so
  // the two counters never collide even when they reach the same position.
  assert.notEqual(type.canonical, gtin.canonical);
  // A prefix beginning with zero forms a U.P.C. Company Prefix, so its own
  // allocations are GTIN-12s; the stored fourteen digits are the same either
  // way, because the leading zeroes are filler (§1.3.1, Table 1-9).
  assert.equal(allocatedGtinFormat('0614141'), 'GTIN-12');
  assert.equal(allocatedGtinFormat('9521234'), 'GTIN-13');
  // The reference space is finite and exhaustion is reported, not wrapped.
  assert.equal(allocatedGtin('95212345678', 9).components.gtin, '09521234567899');
  assert.throws(() => allocatedGtin('95212345678', 10), ValidationError);
});

test('issued serials are drawn under a class key, never invented beside one', () => {
  const type = allocatedGraiAssetType('0614141', 42);
  const gtin = allocatedGtin('0614141', 42);
  const serialised = allocatedGraiSerial(type.components.assetType, 7);
  const sgtin = allocatedSgtin(gtin.components.gtin, 7);
  assert.equal(serialised.canonical, '(8003)006141410004257');
  assert.equal(serialised.level, 'individual');
  assert.equal(sgtin.canonical, '(01)00614141000425(21)7');
  assert.equal(sgtin.level, 'individual');
  for (const sequence of [0, -1, 1.5, '4']) {
    assert.throws(() => allocatedGraiSerial(type.components.assetType, sequence as number),
      ValidationError, String(sequence));
    assert.throws(() => allocatedSgtin(gtin.components.gtin, sequence as number),
      ValidationError, String(sequence));
  }
});

test('adoption refuses the keys a company prefix cannot carry', () => {
  // A base GTIN and a GRAI asset type are adoptable.
  assert.equal(adoptableClassKey({ scheme: 'gtin', gtin: '0614141000425' }).canonical,
    '(01)00614141000425');
  assert.equal(adoptableClassKey({ scheme: 'grai', assetType: '0614141000425' }).canonical,
    '(8003)00614141000425');
  // §2.1.7: an indicator of 1 to 8 identifies a trade item grouping derived
  // from a base GTIN, and §2.1.10 reserves 9 for variable measure, whose
  // measure data completes the identity. Neither is a prefix allocation.
  for (const indicator of ['1', '8', '9']) {
    const body = indicator + '061414100042';
    assert.throws(() => adoptableClassKey({ scheme: 'gtin', gtin: body + checkDigit(body) }),
      ValidationError, indicator);
  }
  // §1.2.3.2: a GTIN-8 comes from a GS1-8 Prefix allocated to Member
  // Organisations, so it is never issued from a company prefix.
  assert.throws(() => adoptableClassKey({ scheme: 'gtin', gtin: '96385074' }), ValidationError);
  // Individual-level keys are not class keys, whatever their scheme.
  assert.throws(() => adoptableClassKey({ scheme: 'grai', assetType: '0614141000425', serial: 'A1' }),
    ValidationError);
  assert.throws(() => adoptableClassKey({ scheme: 'giai', assetReference: '0614141X' }), ValidationError);
  // Containment is checked against the prefix the Group asserted, and nothing
  // stronger: it is not a licensing check.
  const adopted = adoptableClassKey({ scheme: 'gtin', gtin: '0614141000425' });
  assert.equal(classKeyWithinGcp(adopted, '0614141'), true);
  assert.equal(classKeyWithinGcp(adopted, '9521234'), false);
  assert.equal(classKeyWithinGcp(
    adoptableClassKey({ scheme: 'grai', assetType: '0614141000425' }), '0614141'), true);
});

test('allocation adds no guarantee to GIAIs Kannabi merely stores', () => {
  // Phase 2 semantics for an externally supplied GIAI are unchanged: the value
  // is accepted on syntax alone, with no prefix boundary claimed.
  const external = canonicalIdentifier({ scheme: 'giai', assetReference: 'ZZZ-not-a-prefix' });
  assert.equal(external.level, 'individual');
  assert.equal(external.components.assetReference, 'ZZZ-not-a-prefix');
  // gcppos stays globally unenforced, and says why.
  assert.ok(!(enforcedLinters as readonly string[]).includes('gcppos1'));
  assert.match(unenforcedLinters.gcppos1, /GCP Length Table/);
  assert.equal(entries['8004'].components[0].linters.includes('gcppos1'), true);
});

test('rendering descriptors cover every supported scheme without restating validation', () => {
  for (const scheme of identifierSchemes) {
    assert.ok(schemeInputs[scheme].length > 0, scheme);
    for (const input of schemeInputs[scheme]) assert.ok(input.label && input.name);
  }
  assert.deepEqual(Object.fromEntries(identifierSchemes.map((scheme) =>
    [scheme, schemeInputs[scheme].map((input) => input.name)])), {
    gtin: ['gtin'], sgtin: ['gtin', 'serial'], grai: ['assetType', 'serial'], giai: ['assetReference'],
  });
  assert.deepEqual(Object.fromEntries(identifierSchemes.map((scheme) =>
    [scheme, schemeInputs[scheme].map((input) => input.required)])), {
    gtin: [true], sgtin: [true, true], grai: [true, false], giai: [true],
  });
  assert.deepEqual(schemeInputs.grai.map((input) => input.required), [true, false]);
  assert.equal(schemeInputs.giai[0].name, 'assetReference');
  assert.match(schemeInputs.giai[0].label, /GIAI value \(AI 8004\)/);
  assert.match(schemeInputs.giai[0].hint!, /already assigned by an external authority/);
  assert.match(schemeInputs.giai[0].hint!, /validates GS1 syntax/);
  assert.match(schemeInputs.giai[0].hint!, /does not verify who assigned it or who controls its prefix/);
});

test('a class key that names a different trade item cannot be serialised for an Asset', () => {
  const carried = canonicalIdentifier({ scheme: 'gtin', gtin: '00614141123452' });
  const same = { scheme: 'gtin' as const, canonical: carried.canonical };
  const other = { scheme: 'gtin' as const,
    canonical: canonicalIdentifier({ scheme: 'gtin', gtin: '09520123000004' }).canonical };

  // An Asset with no commitment can be serialised under either.
  assert.equal(classKeyConflictReason(same, []), null);
  assert.equal(classKeyConflictReason(other, []), null);

  // Carrying a GTIN commits the Asset to that trade item. The key naming the
  // same one is still usable; the key naming another is refused in advance,
  // with the words the boundary itself would use on submission.
  assert.equal(classKeyConflictReason(same, [carried]), null);
  assert.equal(classKeyConflictReason(other, [carried]),
    'Identifiers claim conflicting GTINs for one Asset');
  assert.throws(() => assertCompatible([carried,
    canonicalIdentifier({ scheme: 'gtin', gtin: '09520123000004' })]),
  /conflicting GTINs/, 'and the same refusal arrives on submission');

  // The commitment is carried by an SGTIN just as much as by a bare GTIN.
  const serialised = canonicalIdentifier({ scheme: 'sgtin', gtin: '00614141123452', serial: 'A1' });
  assert.equal(classKeyConflictReason(other, [serialised]),
    'Identifiers claim conflicting GTINs for one Asset');
});

test('a GRAI asset type is committed to in the same way, and a GIAI never conflicts', () => {
  const carried = canonicalIdentifier({ scheme: 'grai', assetType: '0614141123452' });
  const other = { scheme: 'grai' as const,
    canonical: canonicalIdentifier({ scheme: 'grai', assetType: '9520123000004' }).canonical };
  assert.equal(classKeyConflictReason(other, [carried]),
    'Identifiers claim conflicting GRAI asset types for one Asset');
  assert.equal(classKeyConflictReason({ scheme: 'grai', canonical: carried.canonical }, [carried]), null);
  // A GIAI comes straight from the prefix and shares no component, so there is
  // no class key and nothing to conflict with.
  assert.equal(classKeyConflictReason(null, [carried]), null);
});

test('GTIN consistency is an acceptance policy that only the AI 01 rule obeys', () => {
  const product = canonicalIdentifier({ scheme: 'gtin', gtin: '4901234567894' });
  const labSgtin = canonicalIdentifier({ scheme: 'sgtin', gtin: '04589604681007', serial: '532' });
  const off = { enforceGtinConsistency: false };
  assert.throws(() => assertCompatible([product, labSgtin]), /conflicting GTINs/, 'enforced by default');
  assert.doesNotThrow(() => assertCompatible([product, labSgtin], off));
  assert.deepEqual(canonicalIdentifiers([
    { scheme: 'gtin', gtin: '4901234567894' }, { scheme: 'sgtin', gtin: '04589604681007', serial: '532' },
  ], off).map((identifier) => identifier.scheme), ['gtin', 'sgtin']);
  // Everything else still applies with the policy off.
  assert.throws(() => assertCompatible([product, product], off), /same identifier twice/);
  assert.throws(() => assertCompatible([
    canonicalIdentifier({ scheme: 'grai', assetType: '0614141234561', serial: '1' }),
    canonicalIdentifier({ scheme: 'grai', assetType: '0614141234578', serial: '1' }),
  ], off), /conflicting GRAI asset types/);
  assert.throws(() => canonicalIdentifiers([{ scheme: 'gtin', gtin: '4901234567890' }], off),
    ValidationError, 'check digits are not a policy');
  assert.equal(classKeyConflictReason({ scheme: 'gtin', canonical: product.canonical }, [labSgtin], off), null);
  assert.match(classKeyConflictReason({ scheme: 'gtin', canonical: product.canonical }, [labSgtin]) ?? '',
    /conflicting GTINs/);
});

test('a GTIN conflict is more than one distinct AI 01 value, alone or inside an SGTIN', () => {
  const product = canonicalIdentifier({ scheme: 'gtin', gtin: '4901234567894' });
  const sameInSgtin = canonicalIdentifier({ scheme: 'sgtin', gtin: '04901234567894', serial: '1' });
  const labSgtin = (serial: string) => canonicalIdentifier({ scheme: 'sgtin', gtin: '04589604681007', serial });
  const giai = canonicalIdentifier({ scheme: 'giai', assetReference: '4589604681ASSET' });
  assert.equal(hasGtinConflict([]), false);
  assert.equal(hasGtinConflict([product, giai]), false);
  assert.equal(hasGtinConflict([product, sameInSgtin]), false, 'a GTIN-13 and its GTIN-14 form are one GTIN');
  assert.equal(hasGtinConflict([labSgtin('1'), labSgtin('2')]), false, 'serials of one trade item');
  assert.equal(hasGtinConflict([product, labSgtin('1')]), true);
  assert.equal(hasGtinConflict([labSgtin('1'), sameInSgtin]), true, 'two SGTINs naming different GTINs');
  // The same rule enforcement applies, so the two can never disagree.
  assert.throws(() => assertCompatible([product, labSgtin('1')]), /conflicting GTINs/);
  assert.doesNotThrow(() => assertCompatible([product, sameInSgtin]));
});

test('on an Asset already holding a conflict, a write is judged by what it adds', () => {
  const product = canonicalIdentifier({ scheme: 'gtin', gtin: '4901234567894' });
  const labSgtin = canonicalIdentifier({ scheme: 'sgtin', gtin: '04589604681007', serial: '532' });
  const other = canonicalIdentifier({ scheme: 'gtin', gtin: '4512345678906' });
  const giai = canonicalIdentifier({ scheme: 'giai', assetReference: '4589604681ASSET' });
  const recorded = [product, labSgtin];
  // An identifier with no AI 01 adds no disagreement, so the conflict recorded
  // while the rule was off is no reason to refuse it.
  assert.doesNotThrow(() => assertAttachable(recorded, giai));
  assert.throws(() => assertAttachable(recorded, other), /conflicting GTINs/);
  assert.throws(() => assertAttachable(recorded, giai.canonical === product.canonical ? giai : product),
    /same identifier twice/);
  assert.doesNotThrow(() => assertAttachable(recorded, other, { enforceGtinConsistency: false }));
  // On a coherent Asset it answers exactly as assertCompatible does.
  assert.doesNotThrow(() => assertAttachable([product], canonicalIdentifier({
    scheme: 'sgtin', gtin: '4901234567894', serial: '1' })));
  assert.throws(() => assertAttachable([product], labSgtin), /conflicting GTINs/);
});
