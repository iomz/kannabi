import { Hono, type Context, type Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { validator } from 'hono/validator';
import { isAPIError } from 'better-auth/api';
import { assetPageRequest } from './asset-page.js';
import { assetLookupQuery } from './asset-lookup.js';
import { maxPhotoBytes, type MediaService } from './media.js';
import type { Auth } from './auth.js';
import { record, requiredText, ValidationError } from './identity.js';
import { basisReference, type ChangeOrigin } from './change-provenance.js';
import { validateCreateApiToken, type ApiTokenService, type TokenCredential } from './api-token.js';
import { assetId } from './asset-id.js';
import { identifierInputFields } from './gs1.js';
import { AdministrationError, LastAdministratorError, DuplicateIdentityError, ReferenceError, type IdentityStore, type AssetChanges, type ReportAsset } from './identity-store.js';
import { MailDeliveryError, MailRevisionConflictError, type MailService } from './mail.js';
import { SecretUnavailableError } from './secrets.js';

/** The authenticated caller as the rest of the request sees them. `email` is
 * the caller's own address, carried so a client can show which account is
 * active without a second request; it is never another person's. */
type User = { key: string; name: string; email: string };
type Env = { Variables: { user: User | null; token: TokenCredential | null } };

/** The bearer credential this request presented, if any.
 *
 * Its mere presence changes how the request is treated, so it is read the same
 * way in both middlewares rather than being inferred twice from different
 * rules.
 */
function bearerCredential(header: string | undefined): string | null {
  if (!header || header.slice(0, 7).toLowerCase() !== 'bearer ') return null;
  return header.slice(7).trim() || null;
}
const authPaths = new Set(['/api/auth/sign-up/email', '/api/auth/sign-in/email', '/api/auth/sign-out',
  '/api/auth/get-session', '/api/auth/change-password', '/api/auth/request-password-reset', '/api/auth/reset-password']);
function actor(user: User | null) {
  if (!user) throw new HTTPException(401, { message: 'Sign in required' });
  return user.key;
}

/** Refuses an administrator operation to a token that was not issued for one.
 * It narrows a credential; it never widens one, and it says nothing about
 * Asset access, which stays Group-derived for every caller. */
async function administrativeCredential(c: Context<Env>, next: Next) {
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
function changeOrigin(c: Context<Env>): ChangeOrigin {
  const token = c.get('token');
  const basis = c.req.header('X-Kannabi-Basis');
  return {
    assertedBy: token ? { id: token.id, label: token.label } : null,
    basis: basis === undefined ? null : basisReference(basis),
  };
}

function memberAuthError(error: unknown, fallback: string): never {
  if (!isAPIError(error)) throw error;
  if (error.statusCode === 401) throw new HTTPException(401, { message: 'Sign in required' });
  if (error.statusCode === 403) throw new AdministrationError('Administrator access required');
  throw new HTTPException(error.statusCode === 409 ? 409 : 400, { message: fallback });
}

export function createInventoryApi(store: IdentityStore, auth: Auth, origin: string,
  media?: MediaService, mail?: MailService, tokens?: ApiTokenService) {
  return new Hono<Env>()
    // The Origin requirement exists because a browser attaches cookies to a
    // cross-site request on its own. A bearer credential is never attached
    // automatically, and a cross-origin page cannot add the header without a
    // preflight this API does not answer, so the risk it guards against does
    // not arise for one. Cookie-authenticated writes keep the exact check.
    .use('*', async (c, next) => {
      c.header('Cache-Control', 'no-store');
      const bearer = bearerCredential(c.req.header('Authorization'));
      if (!bearer && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('Origin') !== origin) {
        return c.json({ error: 'Request origin not allowed' }, 403);
      }
      await next();
    })
    .use('*', bodyLimit({ maxSize: maxPhotoBytes + 16384 }))
    .all('/auth/*', (c) => authPaths.has(new URL(c.req.url).pathname)
      ? auth.handler(c.req.raw) : c.json({ error: 'Not found' }, 404))
    .use('*', async (c, next) => {
      const bearer = bearerCredential(c.req.header('Authorization'));
      // Bearer means bearer only. A cookie must never rescue an invalid token,
      // or attaching a meaningless Authorization header would become a way to
      // opt a cookie-authenticated request out of the Origin check above.
      const session = await auth.api.getSession(bearer
        // A token's expiry is absolute. Refreshing would slide it forward and
        // quietly turn a short lifetime into a permanent credential.
        ? { headers: new Headers({ authorization: `Bearer ${bearer}` }), query: { disableRefresh: true } }
        : { headers: c.req.raw.headers });
      const key = session?.user.key;
      if (session && !key) throw new Error('Authenticated User has no domain key');
      // Only a session its owner deliberately named is an API token. A browser
      // session is not presentable as one, so bearer authentication always
      // identifies a programmable credential.
      const label = session?.session.apiTokenLabel;
      const token: TokenCredential | null = bearer && session && typeof label === 'string' && label
        ? { id: session.session.id, label, admin: session.session.apiTokenAdmin === true } : null;
      const authenticated = bearer ? Boolean(token) : Boolean(session);
      c.set('token', token);
      c.set('user', authenticated && session && key
        ? { key, name: session.user.name, email: session.user.email } : null);
      await next();
    })
    // Administrator operations are reachable with a browser session, or with a
    // token its owner issued as admin-enabled. The flag is a ceiling on the
    // credential and never an authority: the owning User's current role still
    // decides, and neither ever reaches an Asset outside their Groups.
    .use('/members', administrativeCredential)
    .use('/members/*', administrativeCredential)
    .use('/admin/*', administrativeCredential)
    .use('/settings', async (c, next) => (c.req.method === 'GET'
      ? next() : administrativeCredential(c, next)))
    .get('/me', async (c) => c.json({ user: c.get('user'), ...await store.accountState(c.get('user')?.key ?? null) }))
    .get('/profile', async (c) => {
      const key = actor(c.get('user'));
      const [member, deletionBlocked] = await Promise.all([store.profile(key), store.ownDeletionBlocked(key)]);
      return c.json({ member, deletionBlocked });
    })
    .patch('/profile', validator('json', (value) => record(value, ['name']) as { name: string }), async (c) => {
      const key = actor(c.get('user'));
      const name = requiredText(c.req.valid('json').name, 'name');
      await auth.api.updateUser({ headers: c.req.raw.headers, body: { name } });
      return c.json({ member: await store.profile(key) });
    })
    .patch('/profile/email', validator('json', (value) =>
      record(value, ['newEmail', 'currentPassword']) as { newEmail: unknown; currentPassword: unknown }), async (c) => {
      const key = actor(c.get('user'));
      const { newEmail, currentPassword } = c.req.valid('json');
      if (typeof newEmail !== 'string' || typeof currentPassword !== 'string') {
        throw new ValidationError('Email and current password are required');
      }
      try {
        await auth.api.verifyPassword({ headers: c.req.raw.headers, body: { password: currentPassword } });
      } catch (error) {
        if (isAPIError(error)) {
          if (error.statusCode === 401) throw new HTTPException(401, { message: 'Sign in required' });
          throw new HTTPException(400, { message: 'Current password is incorrect' });
        }
        throw error;
      }
      try {
        await auth.api.changeEmail({ headers: c.req.raw.headers, body: { newEmail } });
      } catch (error) {
        if (isAPIError(error)) {
          if (error.statusCode === 401) throw new HTTPException(401, { message: 'Sign in required' });
          throw new HTTPException(400, { message: 'Email address could not be changed' });
        }
        throw error;
      }
      const member = await store.profile(key);
      if (member.email !== newEmail.toLowerCase()) {
        throw new HTTPException(409, { message: 'Email address could not be changed' });
      }
      return c.json({ member });
    })
    .patch('/profile/appearance', async (c) =>
      c.json({ appearance: await store.updateAppearance(actor(c.get('user')), await c.req.json()) }))
    // Avatar consent is the User's own, for their own account only. Kannabi
    // contacts Gravatar for nobody who has not asked it to.
    .patch('/profile/avatar', async (c) =>
      c.json({ gravatar: await store.updateGravatar(actor(c.get('user')), await c.req.json()) }))
    .delete('/profile', async (c) => {
      await store.deactivateOwnAccount(actor(c.get('user')));
      return c.json({ deleted: true });
    })
    .get('/members', async (c) => c.json({ members: await store.members(actor(c.get('user'))) }))
    .post('/members', validator('json', (value) => {
      const input = record(value, ['name', 'email', 'isAdmin']);
      if (typeof input.email !== 'string' || typeof input.isAdmin !== 'boolean') {
        throw new ValidationError('Name, email, and administrator status are required');
      }
      return { name: requiredText(input.name, 'name'), email: input.email, isAdmin: input.isAdmin };
    }), async (c) => {
      const input = c.req.valid('json');
      try {
        const created = await auth.api.createUser({ headers: c.req.raw.headers, body: {
          name: input.name, email: input.email, role: input.isAdmin ? 'admin' : 'user',
        } });
        await auth.api.requestPasswordReset({ body: { email: created.user.email } });
        const createdUser = created.user as typeof created.user & { key: string };
        return c.json({ member: await store.profile(createdUser.key), recoveryRequested: true }, 201);
      } catch (error) { memberAuthError(error, 'Member could not be created'); }
    })
    .patch('/members/:key', validator('json', (value) => {
      const input = record(value, ['name', 'email']);
      if (typeof input.email !== 'string') throw new ValidationError('Email is required');
      return { name: requiredText(input.name, 'name'), email: input.email };
    }), async (c) => {
      const actorKey = actor(c.get('user'));
      const target = await store.memberAccount(actorKey, c.req.param('key'));
      const normalizedEmail = c.req.valid('json').email.trim().toLowerCase();
      if (target.key === actorKey && normalizedEmail !== target.email) {
        throw new HTTPException(409, { message: 'Change your own email from Profile' });
      }
      try {
        await auth.api.adminUpdateUser({ headers: c.req.raw.headers, body: { userId: target.id, data: {
          name: c.req.valid('json').name,
          ...(normalizedEmail !== target.email ? { email: normalizedEmail, emailVerified: false } : {}),
        } } });
        if (normalizedEmail !== target.email) {
          await auth.api.revokeUserSessions({ headers: c.req.raw.headers, body: { userId: target.id } });
        }
        return c.json({ member: await store.profile(target.key) });
      } catch (error) { memberAuthError(error, 'Member could not be updated'); }
    })
    .patch('/members/:key/role', validator('json', (value) => {
      const input = record(value, ['isAdmin']);
      if (typeof input.isAdmin !== 'boolean') throw new ValidationError('Administrator status must be a boolean');
      return { isAdmin: input.isAdmin };
    }), async (c) => c.json({ member: await store.updateMemberRole(actor(c.get('user')),
      c.req.param('key'), c.req.valid('json').isAdmin) }))
    .post('/members/:key/recovery', async (c) => {
      const target = await store.memberAccount(actor(c.get('user')), c.req.param('key'));
      try {
        await auth.api.requestPasswordReset({ body: { email: target.email } });
        return c.json({ requested: true });
      } catch (error) { memberAuthError(error, 'Recovery email could not be requested'); }
    })
    .delete('/members/:key/api-tokens/:id', async (c) => {
      if (!tokens) throw new HTTPException(503, { message: 'API tokens unavailable' });
      await tokens.revokeFor(actor(c.get('user')), c.req.param('key'), c.req.param('id'));
      return c.json({ revoked: true });
    })
    .delete('/members/:key', async (c) => {
      await store.deactivateMember(actor(c.get('user')), c.req.param('key'));
      return c.json({ deleted: true });
    })
    .get('/settings', async (c) => c.json({ settings: await store.settings() }))
    .patch('/settings', async (c) => c.json({ settings: await store.updateSettings(actor(c.get('user')), await c.req.json()) }))
    .get('/admin/mail', async (c) => {
      if (!mail) throw new HTTPException(503, { message: 'Mail service unavailable' });
      return c.json({ configuration: await mail.configuration(actor(c.get('user'))) });
    })
    .put('/admin/mail', async (c) => {
      if (!mail) throw new HTTPException(503, { message: 'Mail service unavailable' });
      return c.json({ configuration: await mail.update(actor(c.get('user')), await c.req.json()) });
    })
    .post('/admin/mail/test', async (c) => {
      if (!mail) throw new HTTPException(503, { message: 'Mail service unavailable' });
      await mail.sendTest(actor(c.get('user')), await c.req.json());
      return c.json({ sent: true });
    })
    .post('/admin/secrets/reset', async (c) => {
      if (!mail) throw new HTTPException(503, { message: 'Mail service unavailable' });
      return c.json({ configuration: await mail.resetSecrets(actor(c.get('user')), await c.req.json()) });
    })
    .post('/reports', async (c) => {
      const actorKey = actor(c.get('user'));
      if (!media) throw new HTTPException(503, { message: 'Media storage unavailable' });
      const form = await c.req.formData();
      const input = record(JSON.parse(String(form.get('report'))), ['name', 'identifiers', 'ownerKey', 'groupKey']);
      const { groupKey, ...report } = input;
      const file = form.get('photo');
      if (file !== null && !(file instanceof File)) throw new ValidationError('Expected a photo file');
      const asset = await media.report(report as ReportAsset, { actorKey, groupKey: requiredText(groupKey, 'groupKey') },
        file && file.size ? file : undefined, changeOrigin(c));
      return c.json({ asset }, 201);
    })
    .post('/assets/:id/photos', async (c) => {
      const actorKey = actor(c.get('user'));
      if (!media) throw new HTTPException(503, { message: 'Media storage unavailable' });
      const form = await c.req.formData();
      const file = form.get('photo');
      if (!(file instanceof File)) throw new ValidationError('Expected a photo file');
      return c.json({ asset: await media.add(assetId(c.req.param('id')), actorKey, file, changeOrigin(c)) }, 201);
    })
    .get('/assets/:id/photos/:key', async (c) => {
      if (!media) throw new HTTPException(503, { message: 'Media storage unavailable' });
      const { photo, bytes } = await media.read(assetId(c.req.param('id')), c.req.param('key'), c.get('user')?.key ?? null);
      c.header('Content-Type', photo.contentType);
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('Content-Disposition', 'inline');
      return c.body(new Uint8Array(bytes).buffer);
    })
    .delete('/assets/:id/photos/:key', async (c) => {
      if (!media) throw new HTTPException(503, { message: 'Media storage unavailable' });
      await media.remove(assetId(c.req.param('id')), actor(c.get('user')), c.req.param('key'), changeOrigin(c));
      return c.json({ deleted: true });
    })
    // API tokens. A User issues them only for themself: minting one for
    // somebody else would hand over that User's Group-derived Asset access,
    // which system administration is never allowed to grant. An administrator
    // may stop a credential, which is a different act from creating one.
    .get('/api-tokens', async (c) => {
      if (!tokens) throw new HTTPException(503, { message: 'API tokens unavailable' });
      return c.json({ tokens: await tokens.list(actor(c.get('user'))) });
    })
    .post('/api-tokens', validator('json', validateCreateApiToken), async (c) => {
      if (!tokens) throw new HTTPException(503, { message: 'API tokens unavailable' });
      // The secret appears here and nowhere else, now or later.
      return c.json(await tokens.create(actor(c.get('user')), c.req.valid('json')), 201);
    })
    .delete('/api-tokens/:id', async (c) => {
      if (!tokens) throw new HTTPException(503, { message: 'API tokens unavailable' });
      await tokens.revokeOwn(actor(c.get('user')), c.req.param('id'));
      return c.json({ revoked: true });
    })
    // A User page, for somebody the viewer can already see. It grants no Asset
    // access: the count it shows is counted through the viewer's own
    // readability, and an unreachable person is absent rather than refused.
    .get('/users/:key', async (c) => {
      const profile = await store.userProfile(actor(c.get('user')), c.req.param('key'));
      if (!profile) return c.json({ error: 'User not found' }, 404);
      return c.json({ profile });
    })
    .get('/groups', async (c) => c.json({ groups: await store.listGroups(actor(c.get('user'))) }))
    .post('/groups', validator('json', (value) => {
      const input = record(value, ['name']);
      return { name: requiredText(input.name, 'name') };
    }), async (c) => c.json({ group: await store.createReportingGroup(c.req.valid('json').name, actor(c.get('user'))) }, 201))
    .post('/groups/:key/members', validator('json', (value) => {
      const input = record(value, ['userKey']);
      return { userKey: requiredText(input.userKey, 'userKey') };
    }), async (c) => {
      const added = await store.addGroupMember(actor(c.get('user')), c.req.param('key'), c.req.valid('json').userKey);
      return c.json({ ok: true, added });
    })
    .delete('/groups/:key/membership', async (c) => {
      await store.leaveGroup(actor(c.get('user')), c.req.param('key'));
      return c.json({ ok: true });
    })
    .get('/assets', async (c) => {
      const key = actor(c.get('user'));
      return c.json(await store.findAssets(key, assetPageRequest(c.req.query())));
    })
    // Registered before /assets/:id so the static segment wins. Deterministic
    // identity resolution, deliberately separate from free-text browsing: an
    // identity that is unreadable answers exactly as one that does not exist.
    .get('/assets/lookup', validator('query', (value) =>
      assetLookupQuery(value as Record<string, unknown>)), async (c) =>
      c.json(await store.lookupAssets(actor(c.get('user')), c.req.valid('query'))))
    .post('/assets', validator('json', (value) => {
      const input = record(value, ['name', 'identifiers', 'ownerKey', 'groupKey']);
      return { ...input, groupKey: requiredText(input.groupKey, 'groupKey') } as ReportAsset & { groupKey: string };
    }), async (c) => {
      const actorKey = actor(c.get('user'));
      const { groupKey, ...report } = c.req.valid('json');
      const asset = await store.reportAsset(report, { actorKey, groupKey }, null, changeOrigin(c));
      return c.json({ asset }, 201);
    })
    .get('/assets/:id', async (c) => {
      const user = c.get('user');
      const asset = await store.getAsset(assetId(c.req.param('id')), user?.key ?? null);
      if (!asset) return c.json({ error: 'Asset not found' }, 404);
      const groups = user ? await store.listGroups(user.key) : [];
      return c.json({ asset, canEdit: groups.some((g) => asset.groups.some((access) => access.key === g.key)) });
    })
    .patch('/assets/:id', validator('json', (value) =>
      record(value, ['name', 'ownerKey', 'isPublic']) as AssetChanges), async (c) => {
      const asset = await store.updateAsset(assetId(c.req.param('id')), c.req.valid('json'),
        actor(c.get('user')), changeOrigin(c));
      return c.json({ asset });
    })
    // External identifiers are attached and detached explicitly. Knowing an
    // identifier grants no access: Group authorization is checked as usual.
    .post('/assets/:id/identifiers', validator('json', (value) =>
      record(value, identifierInputFields) as Record<string, string>), async (c) => {
      const asset = await store.attachIdentifier(assetId(c.req.param('id')), actor(c.get('user')),
        c.req.valid('json'), changeOrigin(c));
      return c.json({ asset }, 201);
    })
    .delete('/assets/:id/identifiers/:key', async (c) => {
      const asset = await store.detachIdentifier(assetId(c.req.param('id')), actor(c.get('user')),
        c.req.param('key'), changeOrigin(c));
      return c.json({ asset });
    })
    // Allocation is idempotent: a repeat call returns the existing issuance.
    // Knowing a namespace key grants nothing; the Group join is re-checked here.
    .post('/assets/:id/giai', validator('json', (value) => {
      const input = record(value, ['namespaceKey']);
      return { namespaceKey: requiredText(input.namespaceKey, 'namespaceKey') };
    }), async (c) => {
      const asset = await store.allocateGiai(assetId(c.req.param('id')), actor(c.get('user')),
        c.req.valid('json').namespaceKey, changeOrigin(c));
      return c.json({ asset });
    })
    .get('/giai-namespaces', async (c) =>
      c.json({ namespaces: await store.listGiaiNamespaces(actor(c.get('user'))) }))
    .post('/groups/:key/giai-namespaces', validator('json', (value) =>
      record(value, ['gcp', 'exclusions'])), async (c) =>
      c.json({ namespace: await store.configureGiaiNamespace(actor(c.get('user')),
        c.req.param('key'), c.req.valid('json')) }, 201))
    .patch('/giai-namespaces/:key', validator('json', (value) => {
      const input = record(value, ['active']);
      if (typeof input.active !== 'boolean') throw new ValidationError('Namespace active state must be a boolean');
      return { active: input.active };
    }), async (c) => c.json({ namespace: await store.setGiaiNamespaceActive(actor(c.get('user')),
      c.req.param('key'), c.req.valid('json').active) }))
    .onError((error, c) => {
      if (error instanceof AdministrationError) return c.json({ error: error.message }, 403);
      if (error instanceof LastAdministratorError) return c.json({ error: error.message }, 409);
      if (error instanceof MailRevisionConflictError) return c.json({ error: error.message }, 409);
      if (error instanceof SecretUnavailableError) return c.json({ error: 'Instance master key recovery is required before SMTP credentials can be changed' }, 409);
      if (error instanceof MailDeliveryError) return c.json({ error: error.message, category: error.category },
        ['disabled', 'incomplete', 'credential-unavailable'].includes(error.category) ? 409 : 502);
      if (error instanceof SyntaxError) return c.json({ error: 'Invalid JSON' }, 400);
      if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
      if (error instanceof ReferenceError) return c.json({ error: 'Resource or Group access not found' }, 404);
      if (error instanceof DuplicateIdentityError) return c.json({ error: error.message }, 409);
      if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
      console.error('Inventory request failed', error);
      return c.json({ error: 'Request failed' }, 500);
    });
}
export type InventoryApi = ReturnType<typeof createInventoryApi>;
