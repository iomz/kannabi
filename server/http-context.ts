import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { TokenCredential } from './api-token.js';
import { basisReference, type ChangeOrigin } from './change-provenance.js';
import { AdministrationError } from './identity-store.js';

/** What every API handler, core's or a plugin's, is given about the request.
 *
 * Core's middleware resolves it before any route runs, so a plugin mounted
 * under `/api/<id>/` reads the same authenticated caller core's own routes do
 * and cannot forget to authenticate.
 */

/** The authenticated caller as the rest of the request sees them. `email` is
 * the caller's own address, carried so a client can show which account is
 * active without a second request; it is never another person's. */
export type HttpUser = { key: string; name: string; email: string };
export type HttpEnv = { Variables: { user: HttpUser | null; token: TokenCredential | null } };

export function actor(user: HttpUser | null) {
  if (!user) throw new HTTPException(401, { message: 'Sign in required' });
  return user.key;
}

/** Refuses an administrator operation to a token that was not issued for one.
 * It narrows a credential; it never widens one, and it says nothing about
 * Asset access, which stays Group-derived for every caller. */
export async function administrativeCredential(c: Context<HttpEnv>, next: Next) {
  const token = c.get('token');
  if (token && !token.admin) {
    throw new AdministrationError('This API token may not perform administrator operations');
  }
  await next();
}

/** Where a canonical change came from, as the request can establish it.
 *
 * The asserting credential is taken from whatever authenticated the request,
 * never from its content, so nothing a caller sends can misrepresent the
 * actor. `basis` is the single value a caller supplies, and it is a reference
 * rather than evidence.
 */
export function changeOrigin(c: Context<HttpEnv>): ChangeOrigin {
  const token = c.get('token');
  const basis = c.req.header('X-Kannabi-Basis');
  return {
    assertedBy: token ? { id: token.id, label: token.label } : null,
    basis: basis === undefined ? null : basisReference(basis),
  };
}

