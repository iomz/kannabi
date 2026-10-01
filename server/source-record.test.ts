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

test('the stated instant is optional, and must name an instant', () => {
  const absent = sourceRecordParams({ reference: 'r' });
  assert.equal(absent.sourceRecordedAt, null, 'a source may state no time');
  assert.equal(sourceRecordParams({ reference: 'r', recordedAt: null }).sourceRecordedAt, null);

  const at = (recordedAt: string) =>
    sourceRecordParams({ reference: 'r', recordedAt }).sourceRecordedAt;
  assert.equal(at('2019-04-12T09:30:00Z'), '2019-04-12T09:30:00.000Z');
  // An offset is preserved as the instant it names, never as local wall time.
  assert.equal(at('2019-04-12T18:30:00+09:00'), '2019-04-12T09:30:00.000Z');
  assert.equal(at('2019-04-12T09:30:00.123Z'), '2019-04-12T09:30:00.123Z');
  // RFC 3339's "offset unknown" still names an instant.
  assert.equal(at('2019-04-12T09:30:00-00:00'), '2019-04-12T09:30:00.000Z');
  // A four-digit year below 0100 is valid and must not be remapped into the
  // 1900s, which is what a `Date.UTC` round-trip would do to it.
  assert.equal(at('0099-04-12T09:30:00Z'), '0099-04-12T09:30:00.000Z');
  assert.equal(at('2020-02-29T00:00:00Z'), '2020-02-29T00:00:00.000Z', 'a real leap day');
});

test('a time the source did not state is refused rather than invented', () => {
  // Every one of these is something `new Date` accepts and turns into an
  // instant nobody claimed. The attribution is immutable, so each would be
  // permanent.
  rejects({ reference: 'r', recordedAt: '2019-04-12' },
    'a date alone would become midnight UTC, a precision nobody stated');
  rejects({ reference: 'r', recordedAt: '2019-04-12T09:30:00' },
    'no offset would be read in the server\u2019s own zone, so the same evidence '
    + 'would differ by host configuration');
  rejects({ reference: 'r', recordedAt: 'April 12 2019' },
    'prose is accepted by implementation-specific fallback parsing, in local time');
  rejects({ reference: 'r', recordedAt: '2019' }, 'a bare year would become January 1st');
  rejects({ reference: 'r', recordedAt: '2019-02-30T00:00:00Z' },
    'a date that does not exist would roll over to March 2nd');
  rejects({ reference: 'r', recordedAt: '2019-02-29T00:00:00Z' }, 'not a leap year');
  rejects({ reference: 'r', recordedAt: '2019-13-01T00:00:00Z' }, 'month out of range');
  rejects({ reference: 'r', recordedAt: '2019-04-12T25:00:00Z' }, 'hour out of range');
  rejects({ reference: 'r', recordedAt: '2019-04-12T09:30:00+24:00' }, 'offset hour out of range');
  rejects({ reference: 'r', recordedAt: '2019-04-12T09:30:00+09:60' }, 'offset minute out of range');
  rejects({ reference: 'r', recordedAt: '2019-12-31T23:59:60Z' },
    'a leap second cannot be represented, so it is refused rather than moved');
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
