import { createHash } from 'node:crypto';

/** Gravatar, only for people who asked for it.
 *
 * An email address is enough to look somebody up on a third-party service, so
 * Kannabi never derives one on a User's behalf. The identifier below exists
 * only for a User who turned Gravatar on for themself, and turning it off
 * stops Kannabi producing one at all — there is nothing cached to forget.
 *
 * Verified against Gravatar's current developer documentation rather than
 * recalled: the identifier is the SHA-256 of the address with surrounding
 * whitespace removed and the whole thing lowercased.
 */
export function gravatarIdentifier(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}
