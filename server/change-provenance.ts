import { boundedLabel, opaqueReference, record, requiredText } from './identity.js';

/** The programmable credential that produced a canonical change.
 *
 * `id` is the identity and never changes. `label` is what the credential was
 * called at the moment of the write, kept so provenance stays readable after
 * the credential is renamed or revoked — the same reason a deleted reporter
 * keeps a display name. It is a historical snapshot and nothing else: never
 * matched on, never a key, never a lookup, never an authorization input.
 */
export type AssertingCredential = Readonly<{ id: string; label: string }>;

/** Who made an Asset's current record true, and under whose authority.
 *
 * Kannabi already records who first reported an Asset. This records the most
 * recent canonical change to it, which is a different question: `reportedBy`
 * never moves, and a change made years later has its own actor.
 *
 * `assertedBy` and `acceptedBy` are deliberately separate. A change may be
 * produced by something that is not a person — an API token held by an agent,
 * an integration, an automation — while the authority that admitted it is
 * always the Kannabi User that credential belongs to. Collapsing the two would
 * make it impossible to tell a program's action from a person's decision after
 * the fact, so the distinction is recorded even when the same User is behind
 * both: `assertedBy` is null exactly when the accepting User asserted the
 * change directly through their own browser session.
 *
 * Both are derived from the authenticated credential. Neither is ever supplied
 * by the caller.
 *
 * This is bounded, current-state provenance. It answers who made the record
 * true, never what it used to be; prior values and the sequence of changes are
 * a separate capability.
 *
 * Provenance is evidence, never authority. Nothing here participates in any
 * readability or editability decision, and appearing in it grants nothing.
 */
export type ChangeProvenance = Readonly<{
  assertedBy: AssertingCredential | null;
  /** The User whose authority admitted the change, rendered like any other
   * attribution so a deleted account stays unidentifiable. */
  acceptedBy: Readonly<{ key: string; name: string; status: 'active' | 'deleted' }>;
  acceptedAt: string;
  /** An opaque reference to whatever the asserting client considers the basis
   * of the change. See `basisReference`. */
  basis: string | null;
}>;

/** What a write path may state about where a change came from.
 *
 * `assertedBy` is filled in by whatever authenticated the request, never by
 * the request itself, so nothing here can misrepresent the actor. `basis` is
 * the one value a caller supplies, and it is a reference rather than content.
 */
export type ChangeOrigin = Readonly<{
  assertedBy?: AssertingCredential | null;
  basis?: string | null;
}>;

/** What a token is for, as its holder named it. The bound is shared with
 * every other display label, so provenance stays a fixed cost per Asset. */
export function credentialLabel(value: unknown): string {
  return boundedLabel(value, 'label');
}

function assertingCredential(value: unknown): AssertingCredential {
  const input = record(value, ['id', 'label']);
  return { id: requiredText(input.id, 'credential id'), label: credentialLabel(input.label) };
}

/** The lexical contract for `basis`: the shared opaque-reference grammar,
 * named for this field.
 *
 * `basis` identifies the basis; it is not the basis itself. See
 * `opaqueReference` for why Kannabi never parses one. The same grammar carries
 * an Asset's source-record reference, which is a different fact with the same
 * shape.
 */
export function basisReference(value: unknown): string {
  return opaqueReference(value, 'basis');
}

export type ChangeParameters = Readonly<{
  assertedById: string | null;
  assertedByLabel: string | null;
  basis: string | null;
}>;

/** Flattens an origin into the parameters every write statement stamps.
 *
 * The credential is flattened rather than stored as a map so the projection
 * can rebuild it from ordinary properties, and so a half-written record is
 * impossible: both fields are present together or neither is.
 */
export function changeParams(origin: ChangeOrigin = {}): ChangeParameters {
  const input = record(origin, ['assertedBy', 'basis']);
  const credential = input.assertedBy === undefined || input.assertedBy === null
    ? null : assertingCredential(input.assertedBy);
  return {
    assertedById: credential?.id ?? null,
    assertedByLabel: credential?.label ?? null,
    basis: input.basis === undefined || input.basis === null ? null : basisReference(input.basis),
  };
}
