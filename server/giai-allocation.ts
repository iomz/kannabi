import { record, ValidationError } from './identity.js';

/** Allocation arithmetic for a managed GIAI namespace: which numeric asset
 * references Kannabi may issue, and which candidate comes next.
 *
 * This module knows nothing about GS1 syntax. It deals in candidate sequence
 * numbers; turning one into a GIAI is the GS1 boundary's job.
 */

/** A closed interval of asset-reference numbers Kannabi must never issue. */
export type ExclusionRange = Readonly<{ from: number; to: number }>;

/** Sequences are positive integers, so the first candidate is 1. */
export const firstSequence = 1;

/** A namespace's exclusions are configuration, not a growing ledger, so a
 * modest bound keeps configuration reviewable and the counter cheap. */
export const maxExclusionRanges = 256;

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < firstSequence) {
    throw new ValidationError(`${field} must be a whole number of at least ${firstSequence}`);
  }
  return value;
}

/** Validate and normalise existing-use exclusions into sorted, disjoint,
 * non-adjacent ranges. Merging adjacency matters for allocation: it guarantees
 * that the number after a range is always issuable, so skipping never loops. */
export function canonicalExclusions(value: unknown): ExclusionRange[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError('Excluded references must be a list of ranges');
  if (value.length > maxExclusionRanges) {
    throw new ValidationError(`A namespace supports at most ${maxExclusionRanges} excluded ranges`);
  }
  const ranges = value.map((entry) => {
    const input = record(entry, ['from', 'to']);
    const from = positiveInteger(input.from, 'Excluded range start');
    const to = input.to === undefined ? from : positiveInteger(input.to, 'Excluded range end');
    if (to < from) throw new ValidationError(`Excluded range ${from}-${to} ends before it starts`);
    return { from, to };
  }).sort((left, right) => left.from - right.from);

  const merged: ExclusionRange[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    // Overlapping or adjacent ranges collapse, so `to + 1` is always free.
    if (last && range.from <= last.to + 1) {
      if (range.to > last.to) merged[merged.length - 1] = { from: last.from, to: range.to };
      continue;
    }
    merged.push(range);
  }
  return merged.map((range) => Object.freeze(range));
}

/** Rebuild exclusions from the two parallel lists Neo4j stores them in. */
export function storedExclusions(from: unknown, to: unknown): ExclusionRange[] {
  const starts = Array.isArray(from) ? from : [];
  const ends = Array.isArray(to) ? to : [];
  if (starts.length !== ends.length) {
    throw new Error('Stored exclusion ranges are inconsistent');
  }
  return canonicalExclusions(starts.map((start, index) => ({ from: Number(start), to: Number(ends[index]) })));
}

/** The first issuable candidate at or after `candidate`.
 *
 * Skipping is by range, not by number, so an exclusion covering millions of
 * references costs the same as one covering a single reference. Because ranges
 * are normalised the jump target cannot land in another range, so this scans
 * the ranges once rather than iterating candidates.
 */
export function allocatableSequence(candidate: number, exclusions: readonly ExclusionRange[]): number {
  let next = Math.max(candidate, firstSequence);
  for (const range of exclusions) {
    if (next < range.from) break;
    if (next <= range.to) next = range.to + 1;
  }
  if (!Number.isSafeInteger(next)) {
    throw new ValidationError('The namespace has exhausted its allocatable references');
  }
  return next;
}

/** The compact range notation used for display and entry, as in "1-4,9-11,200".
 * A convenience for humans; the API always exchanges structured ranges. */
export function formatExclusionRanges(ranges: readonly ExclusionRange[]): string {
  return ranges.map((range) => (range.from === range.to ? String(range.from) : `${range.from}-${range.to}`)).join(',');
}

export function parseExclusionRanges(text: string): ExclusionRange[] {
  const entries = text.split(',').map((part) => part.trim()).filter((part) => part.length);
  return canonicalExclusions(entries.map((entry) => {
    const parts = entry.split('-').map((part) => part.trim());
    const [from, to = from] = parts;
    if (parts.length > 2 || !/^\d+$/.test(from) || !/^\d+$/.test(to)) {
      throw new ValidationError(`Excluded range ${JSON.stringify(entry)} must be a number or a number range such as 9-11`);
    }
    return { from: Number(from), to: Number(to) };
  }));
}
