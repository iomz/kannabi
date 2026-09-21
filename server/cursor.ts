import { record, ValidationError } from './identity.js';

/** Keyset cursor mechanics shared by Asset browsing and class-level lookup.
 *
 * Only the encoding and the field whitelist are shared. What a cursor is bound
 * to is the caller's business: browse binds the search and ordering, lookup
 * binds the resolved identity. That keeps the two result sets semantically
 * distinct while the transport stays identical.
 *
 * Cursors are opaque positions, never identities, and never carry authority.
 */

/** Bumped whenever a cursor payload's meaning changes, so a stale cursor from
 * an older deployment fails closed rather than paging incorrectly. */
export const cursorVersion = 2;

export function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ v: cursorVersion, ...payload })).toString('base64url');
}

/** Decode and whitelist a cursor payload. Anything malformed, foreign, or from
 * another cursor version is rejected; callers then compare the bound fields. */
export function decodeCursor(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ValidationError('Invalid cursor');
  }
  const payload = record(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')), ['v', ...fields]);
  if (payload.v !== cursorVersion) throw new ValidationError('Invalid cursor');
  return payload;
}

/** Every bound field must match the current request, so a cursor cannot be
 * replayed against a different query shape or a different identity. */
export function assertBound(payload: Record<string, unknown>, bound: Record<string, unknown>): void {
  for (const [field, expected] of Object.entries(bound)) {
    if (payload[field] !== expected) throw new ValidationError('Invalid cursor');
  }
}

export function cursorText(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || !value) throw new ValidationError('Invalid cursor');
  return value;
}

/** Read one safe-integer field from a decoded cursor payload. */
export function cursorInteger(payload: Record<string, unknown>, field: string): number {
  const value = payload[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new ValidationError('Invalid cursor');
  return value;
}
