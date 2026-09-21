import { ValidationError } from './identity.js';

/** An authenticated principal asserted to Kannabi by whatever fronts it.
 *
 * Kannabi does not authenticate anyone here. A gateway authenticates the human
 * and asserts the result; this type is that assertion, normalised and checked
 * for shape, with no knowledge of how it arrived.
 *
 * The assertion is trusted because of where it came from, not because of
 * anything it carries. For the stdio transport the process boundary is the
 * trust boundary: the only writer to this process's stdin is whatever spawned
 * it. A principal is therefore only as trustworthy as the decision to launch
 * this process from a trusted gateway, which is a deployment property rather
 * than something Kannabi can verify.
 */
export type ExternalPrincipal = Readonly<{
  /** The authority that authenticated the subject. Half of the identity key. */
  issuer: string;
  /** The authority's own stable identifier for the subject. The other half. */
  subject: string;
  /** What the subject is. Only `user` denotes a human Kannabi can map to a User. */
  subjectType: string;
  /** How the gateway authenticated, for diagnostics. Never an authorization input. */
  authKind: string;
  /** The gateway's grant. Kannabi records it and decides for itself; a scope
   * never widens what Kannabi's own model permits. */
  scopes: readonly string[];
  assertedAt: string;
  clientId: string | null;
  /** Display context only. Never an identity key, and never matched against a
   * Kannabi account: two issuers may assert the same address for different
   * people, and an address can be reassigned. */
  email: string | null;
}>;

/** The only subject type Kannabi maps onto a User. Anything else — a
 * deployment owner, or a type introduced later — has no Kannabi User and
 * cannot acquire one by default. */
export const humanSubjectType = 'user';

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`Principal ${field} is required`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError(`Principal ${field} must be a string`);
  return value;
}

/** Normalise an asserted principal, rejecting anything Kannabi cannot read.
 *
 * Unknown fields are ignored rather than refused: the assertion is additive by
 * contract, and a Kannabi that rejected a field added later would break on an
 * upgrade of the thing in front of it. Everything Kannabi acts on is required
 * to be present and well typed.
 */
export function externalPrincipal(value: unknown): ExternalPrincipal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Principal must be an object');
  }
  const input = value as Record<string, unknown>;
  const rawScopes = input.scopes;
  if (rawScopes !== undefined && (!Array.isArray(rawScopes)
    || rawScopes.some((scope) => typeof scope !== 'string'))) {
    throw new ValidationError('Principal scopes must be a list of strings');
  }
  return Object.freeze({
    issuer: requiredString(input.issuer, 'issuer'),
    subject: requiredString(input.subject, 'subject'),
    subjectType: requiredString(input.subject_type, 'subject_type'),
    authKind: requiredString(input.auth_kind, 'auth_kind'),
    scopes: Object.freeze([...(rawScopes as string[] | undefined ?? [])]),
    assertedAt: requiredString(input.asserted_at, 'asserted_at'),
    clientId: optionalString(input.client_id, 'client_id'),
    email: optionalString(input.email, 'email'),
  });
}

/** The stable key for one external identity.
 *
 * Both halves are needed: the same subject string from two issuers is two
 * different people. The encoding is injective, so no pair of issuer and
 * subject can collide with another pair by splitting differently around a
 * separator.
 */
export function externalIdentityKey(issuer: string, subject: string): string {
  return JSON.stringify([issuer, subject]);
}
