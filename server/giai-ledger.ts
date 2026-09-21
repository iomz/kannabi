import { record, requiredText, ValidationError } from './identity.js';
import { assertBound, cursorInteger, decodeCursor, encodeCursor } from './cursor.js';

/** Reading Kannabi's GIAI issuance ledger.
 *
 * The ledger is the only evidence that Kannabi allocated a value. An Asset
 * carrying a GIAI whose text happens to begin with a managed GS1 Company Prefix
 * is not in the ledger and must never be reported as if it were.
 *
 * Issuances are ordered by the sequence the namespace's counter produced, which
 * is unique within one namespace and therefore a complete ordering on its own.
 */
export const giaiLedgerFields = ['namespaceKey', 'limit', 'cursor'] as const;

export type GiaiLedgerRequest = {
  namespaceKey: string; limit: number; after: number | null;
};

/** Validate and normalize a request to page through one namespace's ledger. */
export function giaiLedgerQuery(query: Record<string, unknown>): GiaiLedgerRequest {
  const { namespaceKey, limit: rawLimit, cursor } = record(query, giaiLedgerFields);
  const key = requiredText(namespaceKey, 'namespace key');
  const limit = rawLimit === undefined ? 30 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError('Page size must be an integer between 1 and 100');
  }
  let after: number | null = null;
  if (cursor !== undefined) {
    try {
      const payload = decodeCursor(cursor, ['namespaceKey', 'sequence']);
      assertBound(payload, { namespaceKey: key });
      after = cursorInteger(payload, 'sequence');
    } catch { throw new ValidationError('Invalid issuance cursor for this namespace'); }
  }
  return { namespaceKey: key, limit, after };
}

/** Encode the namespace and last sequence that bind an issuance-page cursor. */
export function giaiLedgerCursor(namespaceKey: string, sequence: number): string {
  return encodeCursor({ namespaceKey, sequence });
}
