import { record, requiredText, ValidationError } from './identity.js';
import { credentialLabel } from './change-provenance.js';
import { apiTokenLifetimeDays } from './settings.js';
import type { Auth } from './auth.js';
import { AdministrationError, ReferenceError, type IdentityStore } from './identity-store.js';

/** An API token as its owner sees it. The secret is absent: it exists once, in
 * the response to the call that created it, and Kannabi cannot show it again. */
export type ApiToken = Readonly<{
  id: string;
  label: string;
  admin: boolean;
  createdAt: string;
  /** Null when the token was created with no expiry. */
  expiresAt: string | null;
  /** Falls out of the session record Better Auth already touches on use. */
  lastUsedAt: string | null;
}>;

export type IssuedApiToken = Readonly<{ token: ApiToken; secret: string }>;

/** The credential this request authenticated with, when it was a token.
 *
 * `admin` is the credential's own ceiling and never an authority: a token may
 * only exercise administrator operations when it was issued as admin-enabled
 * **and** its owner is an administrator at the time of the request.
 */
export type TokenCredential = Readonly<{ id: string; label: string; admin: boolean }>;

/** A token far enough out that it will not expire in any practical sense.
 *
 * Better Auth requires every session to carry an expiry, so "no expiry" is
 * expressed as a date no deployment will reach rather than as a null the
 * session machinery would not understand. It is a storage detail; the domain
 * reports such a token as having no expiry at all.
 */
const noExpiry = new Date('9999-12-31T23:59:59.000Z');
export function hasNoExpiry(expiresAt: Date | string): boolean {
  return new Date(expiresAt).getTime() >= noExpiry.getTime();
}

type SessionRow = {
  id: string; token: string; createdAt: Date | string; updatedAt: Date | string;
  expiresAt: Date | string; apiTokenLabel?: string | null; apiTokenAdmin?: boolean | null;
};

function instant(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

/** Only a session a User deliberately named is an API token. A browser session
 * has no label, and this is the one place that distinction is drawn. */
function isApiToken(row: SessionRow): boolean {
  return typeof row.apiTokenLabel === 'string' && row.apiTokenLabel.length > 0;
}

function asToken(row: SessionRow): ApiToken {
  return {
    id: row.id,
    label: String(row.apiTokenLabel),
    admin: row.apiTokenAdmin === true,
    createdAt: instant(row.createdAt) ?? new Date(0).toISOString(),
    expiresAt: hasNoExpiry(row.expiresAt) ? null : instant(row.expiresAt),
    lastUsedAt: instant(row.updatedAt),
  };
}

export type CreateApiToken = { label: string; lifetimeDays: number | null; admin?: boolean };

export function validateCreateApiToken(value: unknown): CreateApiToken {
  const input = record(value, ['label', 'lifetimeDays', 'admin']);
  if (input.admin !== undefined && typeof input.admin !== 'boolean') {
    throw new ValidationError('Token admin flag must be a boolean');
  }
  // Absent and null are the same request — no expiry — and both have to be
  // stated. There is no implicit lifetime, so nobody creates a permanent
  // credential by leaving a field out.
  const lifetimeDays = input.lifetimeDays === undefined || input.lifetimeDays === null
    ? null : apiTokenLifetimeDays(input.lifetimeDays, 'lifetimeDays');
  return { label: credentialLabel(input.label), lifetimeDays, admin: input.admin === true };
}

/** API tokens over Better Auth's own session storage.
 *
 * A token is a session the owning User named and kept, so revocation, expiry,
 * password-reset invalidation and account deletion all work through machinery
 * that already exists and is already exercised by browser sign-in. Nothing
 * here introduces a second credential store or a second authorization path.
 */
export class ApiTokenService {
  constructor(private readonly auth: Auth, private readonly store: IdentityStore) {}

  private async adapter() {
    return (await this.auth.$context).internalAdapter;
  }

  private async userId(actorKey: string): Promise<string> {
    const id = await this.store.authUserId(requiredText(actorKey, 'actorKey'));
    if (!id) throw new ValidationError('Account is not active');
    return id;
  }

  /** Issues a token for the caller, and only for the caller.
   *
   * An administrator has no path here to another User's credential: minting
   * one would hand them that User's Group-derived Asset access, which system
   * administration is never allowed to grant.
   */
  async create(actorKey: string, input: CreateApiToken): Promise<IssuedApiToken> {
    const { apiTokenMaxLifetimeDays: ceiling } = await this.store.settings();
    if (input.lifetimeDays === null && ceiling !== null) {
      throw new ValidationError(`This instance requires an API token to expire within ${ceiling} days`);
    }
    if (input.lifetimeDays !== null && ceiling !== null && input.lifetimeDays > ceiling) {
      throw new ValidationError(`This instance allows an API token lifetime of at most ${ceiling} days`);
    }
    if (input.admin && !await this.store.isAdministrator(actorKey)) {
      throw new ValidationError('Only a current administrator may issue an admin-enabled token');
    }
    const userId = await this.userId(actorKey);
    // An absolute ceiling, not a sliding window: reads of a token session are
    // made with refresh disabled, so this date is the whole of its lifetime.
    const expiresAt = input.lifetimeDays === null
      ? noExpiry : new Date(Date.now() + input.lifetimeDays * 86400000);
    const created = await (await this.adapter()).createSession(userId, false, {
      expiresAt, apiTokenLabel: input.label, apiTokenAdmin: input.admin === true,
    }, true) as SessionRow | null;
    if (!created) throw new ValidationError('Could not create an API token');
    return { token: asToken(created), secret: created.token };
  }

  async list(actorKey: string): Promise<ApiToken[]> {
    const rows = await (await this.adapter()).listSessions(await this.userId(actorKey)) as SessionRow[];
    return rows.filter(isApiToken).map(asToken)
      .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
  }

  /** Revokes one of the caller's own tokens.
   *
   * Browser sessions are deliberately unreachable: this slice manages API
   * tokens, and a general session manager is a different capability.
   */
  async revokeOwn(actorKey: string, tokenId: string): Promise<void> {
    const id = requiredText(tokenId, 'token id');
    const adapter = await this.adapter();
    const row = (await adapter.listSessions(await this.userId(actorKey)) as SessionRow[])
      .find((session) => session.id === id && isApiToken(session));
    if (!row) throw new ReferenceError('API token not found');
    await adapter.deleteSession(row.token);
  }

  /** Revokes another User's token as instance administration.
   *
   * Stopping a credential is an administrative act; creating one is a grant of
   * the owner's authority, which is why only revocation appears here.
   */
  async revokeFor(actorKey: string, targetKey: string, tokenId: string): Promise<void> {
    // Refused the same way every other member-administration operation is,
    // and before the target is touched, so it discloses nothing either way.
    if (!await this.store.isAdministrator(actorKey)) {
      throw new AdministrationError('Administrator access required');
    }
    await this.revokeOwn(targetKey, tokenId);
  }
}
