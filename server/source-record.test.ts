import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceRecordParams } from './source-record.js';
import { ValidationError } from './identity.js';

/** The attribution's contract, checked without a database.
 *
 * `source-record.integration.test.ts` covers what persistence and the HTTP
 * boundary then do with it. */

const rejects = (value: unknown, because: string) =>
  assert.throws(() => sourceRecordParams(value), ValidationError, because);

test('an absent attribution is three nulls, not a half-written record', () => {
  const nothing = { sourceReference: null, sourceRecordedAt: null, sourceRecordedBy: null };
  assert.deepEqual(sourceRecordParams(undefined), nothing);
  assert.deepEqual(sourceRecordParams(null), nothing);
});

test('the reference anchors the attribution and is required whenever it is present', () => {
  assert.equal(sourceRecordParams({ reference: 'legacy:asset:1483' }).sourceReference,
    'legacy:asset:1483');
  // Quoted properties without an anchor would be a free-floating way to assert
  // arbitrary history about an Asset, which is a different capability.
  rejects({}, 'no reference at all');
  rejects({ recordedAt: '2019-04-12T09:30:00Z' }, 'a time with nothing to attribute it to');
  rejects({ recordedBy: 'A. Rivera' }, 'a name with nothing to attribute it to');
  rejects({ reference: null, recordedBy: 'A. Rivera' }, 'an explicitly absent anchor');
});

test('the reference carries the shared opaque-reference grammar', () => {
  for (const reference of ['a', 'legacy:asset:1483', 'sys/type-1.2_3', '9start']) {
    assert.equal(sourceRecordParams({ reference }).sourceReference, reference);
  }
  for (const reference of ['has space', '_leading', '-leading', 'semi;colon', 'at@sign',
    'x'.repeat(129), '', 'nonascii→', 7, true]) {
    rejects({ reference }, `rejects ${String(reference)}`);
  }
});

test('the stated instant is optional, and normalised to an absolute one', () => {
  const absent = sourceRecordParams({ reference: 'r' });
  assert.equal(absent.sourceRecordedAt, null, 'a source may state no time');
  assert.equal(sourceRecordParams({ reference: 'r', recordedAt: null }).sourceRecordedAt, null);
  assert.equal(
    sourceRecordParams({ reference: 'r', recordedAt: '2019-04-12T09:30:00Z' }).sourceRecordedAt,
    '2019-04-12T09:30:00.000Z');
  // An offset is preserved as the instant it names, never as local wall time.
  assert.equal(
    sourceRecordParams({ reference: 'r', recordedAt: '2019-04-12T18:30:00+09:00' }).sourceRecordedAt,
    '2019-04-12T09:30:00.000Z');
  rejects({ reference: 'r', recordedAt: 'whenever' }, 'unparseable');
  rejects({ reference: 'r', recordedAt: 1555061400000 }, 'not a string');
});

test('the stated recorder is optional display text, bounded and never a key', () => {
  assert.equal(sourceRecordParams({ reference: 'r' }).sourceRecordedBy, null);
  assert.equal(sourceRecordParams({ reference: 'r', recordedBy: null }).sourceRecordedBy, null);
  // Display text, so it takes the names people actually have: spaces,
  // punctuation and non-ASCII scripts all belong to somebody.
  for (const recordedBy of ['A. Rivera', '山田 花子', "O'Neill-Smith"]) {
    assert.equal(sourceRecordParams({ reference: 'r', recordedBy }).sourceRecordedBy, recordedBy);
  }
  rejects({ reference: 'r', recordedBy: 'x'.repeat(81) }, 'beyond the label bound');
  rejects({ reference: 'r', recordedBy: '   ' }, 'blank');
  rejects({ reference: 'r', recordedBy: 'line\nbreak' }, 'control characters');
});

test('an unrecognised field is refused rather than quietly dropped', () => {
  rejects({ reference: 'r', recordedIn: 'somewhere' }, 'unsupported field');
  // Notably the stored property names: the attribution is supplied grouped and
  // flattened by Kannabi, never handed over pre-flattened.
  rejects({ sourceReference: 'r' }, 'stored property names are not input names');
});
