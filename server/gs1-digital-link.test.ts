import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertDigitalLinkSchemes, canonicalIdentifier, digitalLinkKeyFor, gs1Policy,
} from './gs1.js';
import {
  decodeDigitalLinkValue, digitalLinkPath, digitalLinkUri, encodeDigitalLinkValue,
  isDigitalLinkPath, parseDigitalLinkPath,
} from './gs1-digital-link.js';
import { entries } from './gs1-syntax.js';
import { ValidationError } from './identity.js';

const gtin = { scheme: 'gtin', gtin: '0614141123452' } as const;
const sgtin = { scheme: 'sgtin', gtin: '0614141123452', serial: 'A1B2' } as const;
const grai = { scheme: 'grai', assetType: '0614141234561', serial: '789' } as const;
const graiClass = { scheme: 'grai', assetType: '0614141234561' } as const;
const giai = { scheme: 'giai', assetReference: '0614141ASSET-001' } as const;

test('the pinned release supplies the Digital Link primary keys and qualifier order', () => {
  // These are the dictionary's `dlpkey` values, not Kannabi's invention.
  assert.equal(entries['01'].digitalLinkPrimaryKey, true);
  assert.deepEqual(entries['01'].digitalLinkQualifiers, [['22', '10', '21'], ['235']]);
  assert.equal(entries['8003'].digitalLinkPrimaryKey, true);
  assert.equal(entries['8003'].digitalLinkQualifiers, undefined);
  assert.equal(entries['8004'].digitalLinkPrimaryKey, true);
  assert.deepEqual(entries['8004'].digitalLinkQualifiers, [['7040']]);
  // Qualifiers Kannabi does not model are still transcribed, so coverage
  // stays a Kannabi statement rather than a gap in the standard's data.
  assert.ok(entries['01'].digitalLinkQualifiers?.[0].includes('22'));
});

test('every supported scheme is a declared primary key plus an ordered qualifier subsequence', () => {
  assert.doesNotThrow(assertDigitalLinkSchemes);
  // SGTIN uses (21) alone, skipping (22) and (10) — conformant, because
  // qualifiers are optional but ordered.
  const key = digitalLinkKeyFor(canonicalIdentifier(sgtin));
  assert.equal(key.primary.ai, '01');
  assert.deepEqual(key.qualifiers.map((segment) => segment.ai), ['21']);
  // The query-string position exists for future compound forms and is unused.
  assert.deepEqual(key.attributes, []);
});

test('each scheme renders the path form the standard defines', () => {
  assert.equal(digitalLinkPath(canonicalIdentifier(gtin)), '/01/00614141123452');
  assert.equal(digitalLinkPath(canonicalIdentifier(sgtin)), '/01/00614141123452/21/A1B2');
  // The GRAI path carries the whole AI 8003 value, zero filler included.
  assert.equal(digitalLinkPath(canonicalIdentifier(grai)), '/8003/00614141234561789');
  assert.equal(digitalLinkPath(canonicalIdentifier(graiClass)), '/8003/00614141234561');
  assert.equal(digitalLinkPath(canonicalIdentifier(giai)), '/8004/0614141ASSET-001');
});

test('a Digital Link URI is absolute, non-canonical and tolerant of a trailing origin slash', () => {
  const identifier = canonicalIdentifier(giai);
  assert.equal(digitalLinkUri(identifier, 'https://kannabi.example'),
    'https://kannabi.example/8004/0614141ASSET-001');
  assert.equal(digitalLinkUri(identifier, 'https://kannabi.example/'),
    'https://kannabi.example/8004/0614141ASSET-001');
  // Nothing Kannabi emits is a canonical GS1 Digital Link URI: the standard
  // reserves that for id.gs1.org.
  assert.ok(!digitalLinkUri(identifier, 'https://kannabi.example').includes('id.gs1.org'));
});

test('CSET 82 characters illegal in a path segment are encoded, and the rest stay literal', () => {
  assert.equal(encodeDigitalLinkValue('a"b%c/d<e>f?g'), 'a%22b%25c%2Fd%3Ce%3Ef%3Fg');
  // pchar members of CSET 82 are left alone.
  assert.equal(encodeDigitalLinkValue("!&'()*+,-.:;=_"), "!&'()*+,-.:;=_");
  // One pass: the % introduced by an escape is never escaped again.
  assert.equal(encodeDigitalLinkValue('%2F'), '%252F');
  assert.equal(decodeDigitalLinkValue('%252F'), '%2F');
  assert.throws(() => decodeDigitalLinkValue('%zz'), ValidationError);
});

test('a value containing every awkward character survives the round trip exactly', () => {
  for (const reference of ['a/b', '100%', 'x<y>z', 'who?', '%2F', 'MiXeDcAsE', '0614141!&\'()*+,-.:;=_']) {
    const identifier = canonicalIdentifier({ scheme: 'giai', assetReference: reference });
    const path = digitalLinkPath(identifier);
    // No raw separator may appear inside the value, or the path would split.
    assert.equal(path.split('/').length, 3, `${reference} produced ${path}`);
    const address = parseDigitalLinkPath(path);
    assert.equal(address?.kind, 'identifier');
    assert.ok(address?.kind === 'identifier');
    // The stored canonical form is what resolution compares against.
    assert.equal(address.identifier.canonical, identifier.canonical);
    assert.equal(address.identifier.components.assetReference, reference);
  }
});

test('a serial round trips with its case and punctuation intact', () => {
  const identifier = canonicalIdentifier({ ...sgtin, serial: 'aB/c%D' });
  const path = digitalLinkPath(identifier);
  assert.equal(path, '/01/00614141123452/21/aB%2Fc%25D');
  const address = parseDigitalLinkPath(path);
  assert.ok(address?.kind === 'identifier');
  assert.equal(address.identifier.canonical, identifier.canonical);
  assert.equal(address.identifier.components.serial, 'aB/c%D');
});

test('parsing recovers the scheme and level from the path shape alone', () => {
  for (const input of [gtin, sgtin, grai, graiClass, giai]) {
    const identifier = canonicalIdentifier(input);
    const address = parseDigitalLinkPath(digitalLinkPath(identifier));
    assert.ok(address?.kind === 'identifier');
    assert.equal(address.identifier.scheme, identifier.scheme);
    assert.equal(address.identifier.level, identifier.level);
    assert.equal(address.identifier.canonical, identifier.canonical);
    // A parsed identifier is stamped by the policy that accepted it now.
    assert.equal(address.identifier.policyVersion, gs1Policy.version);
  }
});

test('only the numeric path space is Digital Link', () => {
  for (const path of ['/01/00614141123452', '/8004/x', '/00/1', '/8018/1']) {
    assert.equal(isDigitalLinkPath(path), true, path);
  }
  for (const path of ['/asset/abc', '/', '/lookup', '/settings/appearance', '/01x/1', '/012345/1']) {
    assert.equal(isDigitalLinkPath(path), false, path);
    assert.equal(parseDigitalLinkPath(path), null, path);
  }
});

test('a primary key Kannabi does not model is unsupported, not malformed', () => {
  // A valid GS1 Digital Link URI for a key outside Kannabi's four schemes.
  assert.equal(parseDigitalLinkPath('/00/195201234567891232')?.kind, 'unsupported');
  // A supported primary key with a qualifier Kannabi does not model.
  assert.equal(parseDigitalLinkPath('/01/00614141123452/10/LOT1')?.kind, 'unsupported');
  assert.equal(parseDigitalLinkPath('/8004/0614141ASSET-001/7040/1abc')?.kind, 'unsupported');
});

test('a malformed Digital Link address is rejected rather than guessed at', () => {
  for (const path of [
    '/01',                            // no value
    '/01/00614141123452/21',          // dangling qualifier
    '/01/00614141123452//21/A',       // empty segment
    '/01/00614141123451',             // bad check digit
    '/01/abc',                        // not a GTIN
    '/8003/10614141234561789',        // non-zero filler
    '/8003/0614141234561',            // too short to carry a 13-digit type
    '/8004/%zz',                      // broken percent-encoding
  ]) assert.throws(() => parseDigitalLinkPath(path), ValidationError, path);
});

test('a trailing slash is tolerated and does not change the identity', () => {
  const identifier = canonicalIdentifier(giai);
  const address = parseDigitalLinkPath('/8004/0614141ASSET-001/');
  assert.ok(address?.kind === 'identifier');
  assert.equal(address.identifier.canonical, identifier.canonical);
});

test('percent-encoded unreserved characters decode to the same identity', () => {
  // %41 is "A". RFC 3986 makes the two spellings equivalent, so both must
  // resolve to one stored canonical form rather than to two identifiers.
  const address = parseDigitalLinkPath('/8004/%410614141');
  assert.ok(address?.kind === 'identifier');
  assert.equal(address.identifier.components.assetReference, 'A0614141');
  assert.equal(address.identifier.canonical,
    canonicalIdentifier({ scheme: 'giai', assetReference: 'A0614141' }).canonical);
});
