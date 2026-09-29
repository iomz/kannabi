import { record, requiredText, ValidationError } from './identity.js';
import { assertBound, cursorText, decodeCursor, encodeCursor } from './cursor.js';
import { issuanceSchemes, type IssuanceScheme } from './gs1.js';

/** Reading Kannabi's issuance ledger.
 *
 * The ledger is the only evidence that Kannabi allocated a value. An Asset
 * carrying an identifier whose text happens to begin with a managed GS1
 * Company Prefix is not in the ledger and must never be reported as if it
 * were. That holds for every scheme: a recorded GTIN is a recorded GTIN, no
 * matter whose prefix its digits fall inside.
 *
 * Issuances are ordered by their canonical form, which is unique across the
 * ledger. Sequence is deliberately not the ordering: a sequence is unique only
 * within the counter that produced it, and for GRAI and SGTIN that counter
 * belongs to one class key rather than to the namespace, so sequences from
 * several counters do not form a total order.
 */
export const gs1LedgerFields = ['namespaceKey', 'scheme', 'limit', 'cursor'] as const;

export type Gs1LedgerRequest = {
  namespaceKey: string;
  /** Null reads every scheme this namespace has issued. */
  scheme: IssuanceScheme | null;
  limit: number;
  /** The canonical form the previous page ended on. */
  after: string | null;
};

function issuanceScheme(value: unknown): IssuanceScheme {
  if (typeof value !== 'string' || !(issuanceSchemes as readonly string[]).includes(value)) {
    throw new ValidationError(`Issued schemes are ${issuanceSchemes.join(', ')}`);
  }
  return value as IssuanceScheme;
}

export function gs1LedgerQuery(query: Record<string, unknown>): Gs1LedgerRequest {
  const { namespaceKey, scheme, limit: rawLimit, cursor } = record(query, gs1LedgerFields);
  const key = requiredText(namespaceKey, 'namespace key');
  const requested = scheme === undefined || scheme === '' ? null : issuanceScheme(scheme);
  const limit = rawLimit === undefined ? 30 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError('Page size must be an integer between 1 and 100');
  }
  let after: string | null = null;
  if (cursor !== undefined) {
    try {
      const payload = decodeCursor(cursor, ['namespaceKey', 'scheme', 'canonical']);
      // The scheme filter is bound as well as the namespace: the same position
      // means something different once the filter changes, so a cursor carried
      // across that change fails closed rather than paging incorrectly.
      assertBound(payload, { namespaceKey: key, scheme: requested });
      after = cursorText(payload, 'canonical');
    } catch { throw new ValidationError('Invalid issuance cursor for this namespace'); }
  }
  return { namespaceKey: key, scheme: requested, limit, after };
}

export function gs1LedgerCursor(namespaceKey: string, scheme: IssuanceScheme | null,
  canonical: string): string {
  return encodeCursor({ namespaceKey, scheme, canonical });
}
