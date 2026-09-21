import { externalPrincipal, humanSubjectType, type ExternalPrincipal } from './external-principal.js';
import { systemAudience, userAudience, type NamedAudienceInput } from './asset-audience.js';
import { ValidationError } from './identity.js';
import { DuplicateIdentityError, type IdentityStore } from './identity-store.js';

/** Refusal to act for a caller, as distinct from refusing what they asked.
 *
 * Kept separate from `ValidationError` because the two mean different things
 * to whoever is calling: one says the request was malformed, the other says
 * Kannabi will not answer it as this caller, however well formed it is.
 */
export class PrincipalError extends Error {}

/** Where a gateway puts the principal it asserts.
 *
 * The only Levitate-specific fact in Kannabi. It stops here: everything past
 * this module deals in an `ExternalPrincipal`, so another gateway is a second
 * reader of this shape rather than a change to the identity model.
 */
export const principalMetaKey = 'io.github.iomz.levitate/principal';

/** Read the asserted principal out of one request's metadata.
 *
 * Absent and malformed are different answers. Absent means nobody was
 * asserted, which the caller's mode decides what to do with; malformed means
 * something was asserted and could not be read, which is never ignorable.
 */
export function principalFromMeta(meta: Record<string, unknown> | undefined): ExternalPrincipal | null {
  const asserted = meta?.[principalMetaKey];
  if (asserted === undefined || asserted === null) return null;
  try {
    return externalPrincipal(asserted);
  } catch (error) {
    throw new PrincipalError(error instanceof ValidationError
      ? `Asserted principal could not be read: ${error.message}`
      : 'Asserted principal could not be read');
  }
}

/** Decides, per request, whose view of Kannabi an operation runs under. */
export type AudienceResolver = (meta: Record<string, unknown> | undefined) => Promise<NamedAudienceInput>;

/** Read the whole instance, whoever is asking.
 *
 * The accepted posture of a trusted local process: there is no principal to
 * act as, so there is nothing to narrow by. An asserted principal is ignored
 * rather than honoured, because honouring it here would let the presence or
 * absence of a header decide how much a caller sees.
 */
export function systemAudienceResolver(): AudienceResolver {
  return async () => systemAudience;
}

/** Act only as an identified Kannabi User.
 *
 * Every refusal below is the same refusal: Kannabi will not answer without
 * knowing whose question it is. Absence fails closed on its own, so it does
 * not matter whether a gateway refuses an unidentifiable caller itself or
 * forwards the request with nothing attached.
 */
export function principalAudienceResolver(store: IdentityStore): AudienceResolver {
  return async (meta) => {
    const principal = principalFromMeta(meta);
    if (!principal) {
      throw new PrincipalError('This Kannabi server answers only for an authenticated User, '
        + 'and no principal was asserted for this request.');
    }
    if (principal.subjectType !== humanSubjectType) {
      // A deployment owner is provenance about the gateway, not a person
      // Kannabi has an account for, and a type introduced later is unknown by
      // definition. Neither may fall through to a human's access.
      throw new PrincipalError(`An asserted principal of type "${principal.subjectType}" is not a Kannabi User. `
        + `Only "${humanSubjectType}" identifies a person this server can act for.`);
    }
    // Issuer and subject only. The scopes a gateway granted describe what it
    // allowed through, never what Kannabi permits, and the resolved User's
    // Groups remain the whole of the authorization decision.
    let user;
    try {
      user = await store.userForExternalIdentity(principal.issuer, principal.subject);
    } catch (error) {
      // An identity owned by several Users cannot be acted for at all, and the
      // caller must see a refusal rather than a transport-level failure.
      if (!(error instanceof DuplicateIdentityError)) throw error;
      throw new PrincipalError('That authenticated identity is linked to more than one Kannabi User, '
        + 'so this server will not act for it. An administrator must repair the link.');
    }
    if (!user) {
      throw new PrincipalError('That authenticated identity is not linked to a Kannabi User. '
        + 'An administrator links one with `pnpm identity:link`.');
    }
    return userAudience(user.key);
  };
}
