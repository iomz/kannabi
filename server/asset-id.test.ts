import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetId, assetIdPattern, isAssetId, newAssetId } from './asset-id.js';
import { ValidationError } from './identity.js';

const uuidv7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('generated Asset IDs are distinct RFC 9562 UUIDv7 values', () => {
  const ids = Array.from({ length: 1000 }, newAssetId);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, uuidv7);
    assert.ok(isAssetId(id));
    assert.equal(assetId(id), id);
  }
});

test('only well-formed native Asset IDs are accepted', () => {
  for (const value of [
    '', ' ', null, undefined, 42, {},
    '00000000-0000-0000-0000-000000000000',
    // UUIDv4 is not the native Asset identity form.
    '958558e2-4a1f-47e4-9df3-2d1c02056f97',
    newAssetId().toUpperCase(),
    newAssetId() + 'a', newAssetId().slice(0, -1),
    ' ' + newAssetId(), 'urn:uuid:' + newAssetId(),
    // External identifiers never address an Asset.
    'sgtin', '00614141234561789',
  ]) {
    assert.equal(isAssetId(value), false, String(value));
    assert.throws(() => assetId(value), ValidationError);
  }
});

test('the persisted-id pattern and isAssetId accept exactly the same values', () => {
  // Persistence verifies stored ids with assetIdPattern; the API validates
  // input with isAssetId. A divergence would let one accept what the other
  // rejects, so pin them together.
  const whole = new RegExp('^' + assetIdPattern + '$');
  const corpus = [
    ...Array.from({ length: 200 }, newAssetId),
    '', ' ', '00000000-0000-0000-0000-000000000000',
    '958558e2-4a1f-47e4-9df3-2d1c02056f97',
    '01a0bc17-85ad-71d2-b740-c1b89e050f3c',
    '01A0BC17-85AD-71D2-B740-C1B89E050F3C',
    '01a0bc17-85ad-61d2-b740-c1b89e050f3c',
    '01a0bc17-85ad-71d2-f740-c1b89e050f3c',
    '01a0bc17-85ad-71d2-b740-c1b89e050f3',
    '01a0bc17-85ad-71d2-b740-c1b89e050f3ca',
    'urn:uuid:01a0bc17-85ad-71d2-b740-c1b89e050f3c',
    '01a0bc17-85ad-71d2-b740-c1b89e050f3c\n',
    'banana', '00614141234561789',
  ];
  for (const value of corpus) assert.equal(whole.test(value), isAssetId(value), value);
});

test('the UUIDv7 timestamp carries no Kannabi domain meaning', () => {
  // Ordering is an encoding property of UUIDv7, never Asset chronology.
  // Nothing in the domain may read creation order from these values.
  const id = newAssetId();
  assert.equal(id.length, 36);
  assert.equal(id[14], '7');
});
