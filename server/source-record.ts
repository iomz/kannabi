import { boundedLabel, opaqueReference, record, ValidationError } from './identity.js';

/** The pre-existing record an Asset was created from, as that record describes
 * itself.
 *
 * Kannabi records who reported an Asset and when: `reportedBy` is the Kannabi
 * User who reported it, `reportedAt` is when Kannabi recorded it. Both describe
 * events in Kannabi. A deployment adopting Kannabi from a prior system holds
 * records that already existed somewhere else, each with its own recording time
 * and its own named recorder, and neither belongs in a field that means
 * "Kannabi".
 *
 * Everything here is therefore quoted. Kannabi asserts only that the source
 * record says so, never that it is true. `reportedAt` stays the sole Asset
 * chronology and is never backdated from `recordedAt`; `reportedBy` stays the
 * authenticated reporter and is never replaced by `recordedBy`.
 *
 * This is not a general provenance framework and must not become one. It is one
 * immutable attribution to one identified record, set when the Asset is
 * created and never afterwards.
 */
export type SourceRecord = Readonly<{
  /** An opaque reference to the source record. Kannabi never generates,
   * parses, dereferences or registers namespace meaning for one. */
  reference: string;
  /** The instant the source record states it recorded the Asset, or null when
   * it states none. Never Kannabi's own chronology. */
  recordedAt: string | null;
  /** The name the source record states recorded it, or null when it states
   * none. Display text and nothing else: never resolved to a User, never
   * matched on, never keyed by, never looked up, and never an authorization
   * input. A recorder named in a pre-existing record may never have held a
   * Kannabi account, so representing them as a User in any state — including a
   * tombstone, which means a User that once existed here — would assert a
   * membership that never happened. */
  recordedBy: string | null;
}>;

/** What a creation path may state about the record an Asset came from.
 *
 * `reference` anchors the attribution and is required whenever any of this is
 * supplied. Without the anchor the other two degrade into a free-floating way
 * to assert arbitrary historical claims about an Asset, which is a different
 * and much larger capability than this one. With it, every quoted property is
 * attributable to something identifiable, and a reader who needs more than
 * Kannabi holds knows where to ask.
 */
export type SourceRecordInput = Readonly<{
  reference: string;
  recordedAt?: string | null;
  recordedBy?: string | null;
}>;

/** An instant the source stated, and only an instant.
 *
 * `new Date()` is far too willing here, and every way it is willing produces a
 * time the source did not state:
 *
 *  - a date alone becomes midnight UTC, which is a precision nobody claimed;
 *  - a date and time with no offset is read in the server's own zone, so the
 *    same quoted evidence lands nine hours apart on a Tokyo host and a UTC one
 *    — configuration deciding what a source said;
 *  - prose like `April 12 2019` is accepted through implementation-specific
 *    fallback parsing, also in local time;
 *  - a date that does not exist rolls over silently, so `2019-02-30T00:00:00Z`
 *    is stored as the 2nd of March;
 *  - a fraction finer than a millisecond is truncated, so `09:30:00.123456Z`
 *    becomes `09:30:00.123Z`.
 *
 * The attribution is immutable, so any of those would be permanent. An instant
 * needs a date, a time and an explicit offset, so that is what is required, and
 * the calendar is checked before the string is parsed.
 *
 * Deliberately stricter than `assetFilters`' own instant parsing, which accepts
 * a plain date because a filter bound naming a whole day is a sensible thing to
 * ask for. Quoted evidence is not a bound.
 */
const rfc3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function sourceInstant(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  const match = rfc3339.exec(value);
  // One message for every way of failing: what is wanted is easier to act on
  // than which of several rules was broken.
  const refuse = () => {
    throw new ValidationError(`${field} must be an instant with an explicit UTC offset, `
      + 'such as 2019-04-12T09:30:00Z or 2019-04-12T18:30:00+09:00');
  };
  if (!match) refuse();
  const [, year, month, day, hour, minute, second, fraction, , offsetHour, offsetMinute] = match!;
  // `Date` keeps milliseconds and drops the rest, so a source stating
  // microseconds would have its instant quietly changed on the way in — the
  // same loss this whole function exists to prevent, one order of magnitude
  // down. Trailing zeros are a different spelling of the same instant and stay
  // acceptable; a nonzero digit past the third is information Kannabi cannot
  // keep, so it is refused rather than silently discarded.
  if (fraction !== undefined && /[1-9]/.test(fraction.slice(3))) refuse();
  // Checked here rather than by round-tripping through `Date.UTC`, which remaps
  // years 0 to 99 onto 1900 to 1999 and would reject four-digit years below
  // 0100 that are perfectly valid.
  const [y, mo, d, h, mi, sec] = [year, month, day, hour, minute, second].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) refuse();
  // RFC 3339 permits second 60 for a leap second; `Date` cannot represent one
  // and refuses it below, so one is rejected rather than quietly moved to the
  // next minute. A source that recorded a leap second has to lose it somewhere,
  // and losing it with a message beats storing a different instant.
  if (h > 23 || mi > 59 || sec > 59) refuse();
  if (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) refuse();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) refuse();
  return parsed.toISOString();
}

export type SourceRecordParameters = Readonly<{
  sourceReference: string | null;
  sourceRecordedAt: string | null;
  sourceRecordedBy: string | null;
}>;

/** Flattens an attribution into the parameters the creating statement stamps.
 *
 * Flattened rather than stored as a map for the same reason a credential is:
 * the projection can rebuild it from ordinary properties, and a half-written
 * attribution is impossible because `sourceReference` is present exactly when
 * the attribution is. Absent input yields three nulls, which is how an Asset
 * that came from nowhere in particular is recorded.
 */
export function sourceRecordParams(value: unknown): SourceRecordParameters {
  if (value === undefined || value === null) {
    return { sourceReference: null, sourceRecordedAt: null, sourceRecordedBy: null };
  }
  const input = record(value, ['reference', 'recordedAt', 'recordedBy']);
  const absent = (field: unknown) => field === undefined || field === null;
  return {
    sourceReference: opaqueReference(input.reference, 'source record reference'),
    sourceRecordedAt: absent(input.recordedAt) ? null
      : sourceInstant(input.recordedAt, 'source record recordedAt'),
    sourceRecordedBy: absent(input.recordedBy) ? null
      : boundedLabel(input.recordedBy, 'source record recordedBy'),
  };
}
