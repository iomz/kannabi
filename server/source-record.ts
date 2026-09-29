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

/** An instant as the source stated it, normalised to an absolute one.
 *
 * Stored absolutely because a quoted time with an implied zone is a claim
 * Kannabi would be making on the source's behalf. */
function sourceInstant(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`${field} must be an ISO date or instant`);
  }
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
