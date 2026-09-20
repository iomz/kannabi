import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allocatableSequence, canonicalExclusions, firstSequence, formatExclusionRanges,
  maxExclusionRanges, parseExclusionRanges, storedExclusions,
} from './giai-allocation.js';
import { ValidationError } from './identity.js';

test('a namespace with no existing use starts at the first sequence', () => {
  assert.deepEqual(canonicalExclusions(undefined), []);
  assert.deepEqual(canonicalExclusions([]), []);
  assert.equal(allocatableSequence(firstSequence, []), 1);
  assert.equal(allocatableSequence(37, []), 37);
});

test('exclusion ranges normalise to sorted, disjoint, non-adjacent intervals', () => {
  // Out of order, overlapping, adjacent, and single-number entries all collapse.
  assert.deepEqual(canonicalExclusions([
    { from: 200, to: 300 }, { from: 1, to: 4 }, { from: 9, to: 11 },
  ]), [{ from: 1, to: 4 }, { from: 9, to: 11 }, { from: 200, to: 300 }]);
  assert.deepEqual(canonicalExclusions([{ from: 1, to: 5 }, { from: 3, to: 9 }]), [{ from: 1, to: 9 }]);
  assert.deepEqual(canonicalExclusions([{ from: 1, to: 4 }, { from: 5, to: 8 }]), [{ from: 1, to: 8 }]);
  assert.deepEqual(canonicalExclusions([{ from: 1, to: 9 }, { from: 3, to: 4 }]), [{ from: 1, to: 9 }]);
  assert.deepEqual(canonicalExclusions([{ from: 7 }]), [{ from: 7, to: 7 }]);
  // Merging adjacency is what guarantees `to + 1` is always issuable.
  for (const ranges of [canonicalExclusions([{ from: 1, to: 4 }, { from: 5, to: 8 }])]) {
    for (const [index, range] of ranges.entries()) {
      const next = ranges[index + 1];
      if (next) assert.ok(range.to + 1 < next.from);
    }
  }
});

test('malformed, reversed and non-positive ranges are rejected', () => {
  for (const value of [
    'ranges', 42, [{ from: 0 }], [{ from: -1, to: 5 }], [{ from: 9, to: 4 }],
    [{ from: 1.5, to: 4 }], [{ from: 1, to: 4.5 }], [{ from: '1', to: '4' }],
    [{ from: 1, to: 4, step: 2 }], [{ to: 4 }], [{}],
    [{ from: Number.MAX_SAFE_INTEGER + 2 }],
    Array.from({ length: maxExclusionRanges + 1 }, (_, index) => ({ from: index * 3 + 1 })),
  ]) assert.throws(() => canonicalExclusions(value), ValidationError, JSON.stringify(value));
});

test('allocation skips excluded ranges by jumping, never by counting', () => {
  const exclusions = canonicalExclusions([{ from: 1, to: 4 }, { from: 9, to: 11 }, { from: 200, to: 300 }]);
  const issued: number[] = [];
  let next = firstSequence;
  for (let n = 0; n < 6; n++) {
    const sequence = allocatableSequence(next, exclusions);
    issued.push(sequence);
    next = sequence + 1;
  }
  assert.deepEqual(issued, [5, 6, 7, 8, 12, 13]);
  assert.equal(allocatableSequence(199, exclusions), 199);
  assert.equal(allocatableSequence(200, exclusions), 301);
  assert.equal(allocatableSequence(250, exclusions), 301);

  // A range covering a trillion references costs the same as one covering one:
  // the work is bounded by the number of ranges, not their size.
  const huge = canonicalExclusions([{ from: 1, to: 1_000_000_000_000 }]);
  const started = process.hrtime.bigint();
  assert.equal(allocatableSequence(1, huge), 1_000_000_000_001);
  assert.ok(process.hrtime.bigint() - started < 5_000_000n, 'skipping must not iterate candidates');
});

test('exclusions round-trip through the two lists Neo4j stores', () => {
  const ranges = canonicalExclusions([{ from: 9, to: 11 }, { from: 1, to: 4 }]);
  assert.deepEqual(storedExclusions(ranges.map((r) => r.from), ranges.map((r) => r.to)), ranges);
  assert.deepEqual(storedExclusions(undefined, undefined), []);
  assert.throws(() => storedExclusions([1, 9], [4]), /inconsistent/);
});

test('the compact range notation is for humans and normalises on the way in', () => {
  assert.equal(formatExclusionRanges(canonicalExclusions([{ from: 1, to: 4 }, { from: 7 }])), '1-4,7');
  assert.deepEqual(parseExclusionRanges('1-4, 9-11 ,200-300'),
    [{ from: 1, to: 4 }, { from: 9, to: 11 }, { from: 200, to: 300 }]);
  assert.deepEqual(parseExclusionRanges(' '), []);
  assert.deepEqual(parseExclusionRanges('5'), [{ from: 5, to: 5 }]);
  assert.deepEqual(parseExclusionRanges('5-8,6-9'), [{ from: 5, to: 9 }]);
  for (const text of ['a', '1-', '-4', '1-2-3', '1,,x', '0', '9-4']) {
    assert.throws(() => parseExclusionRanges(text), ValidationError, text);
  }
});
