import { ValidationError } from './identity.js';
import {
  digitalLinkKeyFor, identifierFromDigitalLink,
  type DigitalLinkSegment, type ExternalIdentifier,
} from './gs1.js';

/** Everything a Digital Link URI needs from an identifier. Narrower than
 * `ExternalIdentifier` so a projection carrying only what it renders — an
 * Asset's identifier summary, say — needs no cast to be rendered. */
type RenderableIdentifier = Pick<ExternalIdentifier, 'scheme' | 'components'>;

/** GS1 Digital Link URI syntax: rendering an identifier as a Web address, and
 * reading one back.
 *
 * This sits inside the GS1 boundary. Which AI is a primary key and which
 * qualifiers it takes is policy and lives in `gs1.ts` and `gs1-syntax.ts`;
 * this module only turns that structure into a URI and back.
 *
 * Nothing here is a canonical GS1 Digital Link URI. The standard reserves that
 * term for HTTPS on `id.gs1.org`, and Kannabi emits URIs on a deployment's own
 * origin, which are valid and non-canonical by that definition.
 */

/** Characters of GS1 CSET 82 that are not legal in an RFC 3986 path segment.
 *
 * The remaining CSET 82 characters — `!&'()*+,-.:;=_` and the alphanumerics —
 * are `pchar` and stay literal. A GIAI or serial may legitimately contain any
 * of these six, so this is correctness rather than caution: the standard gives
 * `/414/9520123456788/254/32a%2Fb` for the literal value `32a/b`.
 */
const pathEscapes: Readonly<Record<string, string>> = Object.freeze({
  '"': '%22', '%': '%25', '/': '%2F', '<': '%3C', '>': '%3E', '?': '%3F',
});

/** One pass, so the `%` introduced by an escape is never itself escaped. */
export function encodeDigitalLinkValue(value: string): string {
  return value.replace(/["%/<>?]/g, (character) => pathEscapes[character]);
}

/** Exactly once. A value containing a literal `%` arrives as `%25`, and a
 * second decode would turn `%2541` into `A` rather than into `%41`. */
export function decodeDigitalLinkValue(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new ValidationError('A Digital Link path segment is not valid percent-encoding');
  }
}

function segments(key: { primary: DigitalLinkSegment; qualifiers: readonly DigitalLinkSegment[] }) {
  return [key.primary, ...key.qualifiers];
}

/** The path of this identifier's GS1 Digital Link URI, origin excluded. */
export function digitalLinkPath(identifier: RenderableIdentifier): string {
  const key = digitalLinkKeyFor(identifier);
  const path = segments(key)
    .map((segment) => `/${segment.ai}/${encodeDigitalLinkValue(segment.value)}`).join('');
  if (!key.attributes.length) return path;
  // Data attributes are query parameters keyed by AI. The standard asks for
  // lexical, not numeric, ordering of the keys.
  const query = [...key.attributes]
    .sort((left, right) => (left.ai < right.ai ? -1 : left.ai > right.ai ? 1 : 0))
    .map((attribute) => `${attribute.ai}=${encodeURIComponent(attribute.value)}`).join('&');
  return `${path}?${query}`;
}

export function digitalLinkUri(identifier: RenderableIdentifier, origin: string): string {
  return origin.replace(/\/$/, '') + digitalLinkPath(identifier);
}

/** A path Kannabi read as a Digital Link address.
 *
 * `unsupported` is a well-formed address naming a GS1 primary key Kannabi does
 * not model. It is deliberately distinct from `null`: the numeric path space
 * belongs to Digital Link, so such an address is one Kannabi does not serve
 * rather than one it has never heard of.
 */
export type DigitalLinkAddress =
  | Readonly<{ kind: 'identifier'; identifier: ExternalIdentifier }>
  | Readonly<{ kind: 'unsupported' }>;

/** A leading path segment of two to four digits marks the Digital Link space.
 * Kannabi mounts Digital Link at the root of its origin, so that whole space
 * is reserved and is never handed to an application route. */
const aiSegment = /^\d{2,4}$/;

export function isDigitalLinkPath(rawPath: string): boolean {
  return aiSegment.test(rawPath.split('/')[1] ?? '');
}

/** Read a raw, still-encoded path as a Digital Link address.
 *
 * `null` means the path is not in the Digital Link space at all. A malformed
 * address throws, because a caller that reached this space and got the syntax
 * wrong deserves a 400 rather than a page.
 *
 * The path must be the raw one. A path decoded before it is split loses the
 * distinction between a `/` separating segments and a `%2F` inside a value.
 */
export function parseDigitalLinkPath(rawPath: string): DigitalLinkAddress | null {
  if (!isDigitalLinkPath(rawPath)) return null;
  const parts = rawPath.split('/').slice(1);
  // A trailing slash leaves one empty part; anything else empty is malformed.
  if (parts.at(-1) === '') parts.pop();
  if (!parts.length || parts.length % 2 !== 0 || parts.some((part) => part === '')) {
    throw new ValidationError('A Digital Link path is a sequence of application identifier and value pairs');
  }
  const pairs: DigitalLinkSegment[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const ai = parts[index];
    if (!aiSegment.test(ai)) {
      throw new ValidationError(`${JSON.stringify(ai)} is not a GS1 application identifier`);
    }
    pairs.push({ ai, value: decodeDigitalLinkValue(parts[index + 1]) });
  }
  const [primary, ...qualifiers] = pairs;
  const identifier = identifierFromDigitalLink(primary, qualifiers);
  return identifier
    ? Object.freeze({ kind: 'identifier' as const, identifier })
    : Object.freeze({ kind: 'unsupported' as const });
}
