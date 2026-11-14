import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { validator } from 'hono/validator';
import { isAPIError } from 'better-auth/api';
import { assetPageRequest } from './asset-page.js';
import { assetLookupQuery } from './asset-lookup.js';
import { publicAudience } from './asset-audience.js';
import { assetPath } from '../shared/asset-uri.js';
import { noPlugins, pluginContract, type Plugins } from './plugin.js';
import { maxPhotoBytes, type MediaService } from './media.js';
import type { Auth } from './auth.js';
import { record, requiredText, ValidationError } from './identity.js';
import { validateCreateApiToken, type ApiTokenService, type TokenCredential } from './api-token.js';
import { actor, administrativeCredential, changeOrigin, type HttpEnv as Env } from './http-context.js';
import { assetId } from './asset-id.js';
import { AdministrationError, ConflictError, LastAdministratorError, LastCollaborationError, DuplicateIdentityError, ReferenceError, groupRole, type IdentityStore, type AssetChanges, type ReportAsset } from './identity-store.js';
import { MailDeliveryError, MailRevisionConflictError, type MailService } from './mail.js';
import { SecretUnavailableError } from './secrets.js';
import { assetRecord, assetRepresentation, assetSummary, summaryOmits } from './asset-representation.js';

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
/** What an account waiting for approval may still reach: itself, and the
 * public settings every visitor reads. */
function ownAccountPath(pathname: string): boolean {
  const path = pathname.replace(/^\/api/, '');
  return path === '/me' || path === '/settings' || path === '/profile' || path.startsWith('/profile/');
}

function memberAuthError(error: unknown, fallback: string): never {
  if (!isAPIError(error)) throw error;
  if (error.statusCode === 401) throw new HTTPException(401, { message: 'Sign in required' });
  if (error.statusCode === 403) throw new AdministrationError('Administrator access required');
  throw new HTTPException(error.statusCode === 409 ? 409 : 400, { message: fallback });
}

export function createInventoryApi(store: IdentityStore, auth: Auth, origin: string,
  media?: MediaService, mail?: MailService, tokens?: ApiTokenService, plugins: Plugins = noPlugins) {
  /** How a refusal is answered, for core's routes and every plugin's alike. */
  const refused = (error: Error, c: Context<Env>) => {
    if (error instanceof AdministrationError) return c.json({ error: error.message }, 403);
    if (error instanceof ConflictError) return c.json({ error: error.message, ...error.detail }, 409);
    if (error instanceof LastAdministratorError) return c.json({ error: error.message }, 409);
    if (error instanceof LastCollaborationError) return c.json({ error: error.message }, 409);
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
  };
  const core = new Hono<Env>()
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
      const user = authenticated && session && key
        ? { key, name: session.user.name, email: session.user.email } : null;
      // An account waiting for approval is signed in to its own account and to
      // nothing else: everywhere else it is answered as an anonymous visitor,
      // so it reads public Assets exactly as anybody may and reaches no
      // directory, Group or change. Read per request, so approval or deletion
      // takes effect at once.
      const pending = user !== null && !await store.isParticipant(user.key);
      c.set('user', pending && !ownAccountPath(new URL(c.req.url).pathname) ? null : user);
      await next();
    })
    // Administrator operations are reachable with a browser session, or with a
    // token its owner issued as admin-enabled. The flag is a ceiling on the
    // credential and never an authority: the owning User's current role still
    // decides, and neither ever reaches an Asset outside their Groups.
    .use('/admin/*', administrativeCredential)
    // The same ceiling for a plugin's administrator operations, applied here
    // so a plugin cannot forget it.
    .use('/:plugin/admin/*', administrativeCredential)
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
    .get('/admin/users', async (c) => c.json({ users: await store.users(actor(c.get('user'))) }))
    .post('/admin/users', validator('json', (value) => {
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
        // An administrator creating an account has already decided it belongs.
        await store.approveUser(actor(c.get('user')), createdUser.key);
        return c.json({ user: await store.profile(createdUser.key), recoveryRequested: true }, 201);
      } catch (error) { memberAuthError(error, 'User could not be created'); }
    })
    .patch('/admin/users/:key', validator('json', (value) => {
      const input = record(value, ['name', 'email']);
      if (typeof input.email !== 'string') throw new ValidationError('Email is required');
      return { name: requiredText(input.name, 'name'), email: input.email };
    }), async (c) => {
      const actorKey = actor(c.get('user'));
      const target = await store.managedUserAccount(actorKey, c.req.param('key'));
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
        return c.json({ user: await store.profile(target.key) });
      } catch (error) { memberAuthError(error, 'User could not be updated'); }
    })
    .patch('/admin/users/:key/role', validator('json', (value) => {
      const input = record(value, ['isAdmin']);
      if (typeof input.isAdmin !== 'boolean') throw new ValidationError('Administrator status must be a boolean');
      return { isAdmin: input.isAdmin };
    }), async (c) => c.json({ user: await store.updateUserRole(actor(c.get('user')),
      c.req.param('key'), c.req.valid('json').isAdmin) }))
    .post('/admin/users/:key/recovery', async (c) => {
      const target = await store.managedUserAccount(actor(c.get('user')), c.req.param('key'));
      try {
        await auth.api.requestPasswordReset({ body: { email: target.email } });
        return c.json({ requested: true });
      } catch (error) { memberAuthError(error, 'Recovery email could not be requested'); }
    })
    .delete('/admin/users/:key/api-tokens/:id', async (c) => {
      if (!tokens) throw new HTTPException(503, { message: 'API tokens unavailable' });
      await tokens.revokeFor(actor(c.get('user')), c.req.param('key'), c.req.param('id'));
      return c.json({ revoked: true });
    })
    // Approving lets a waiting account take part. Rejecting is the deletion
    // below: a rejected applicant keeps no account.
    .post('/admin/users/:key/approval', async (c) => c.json(
      await store.approveUser(actor(c.get('user')), c.req.param('key'))))
    .delete('/admin/users/:key', async (c) => {
      await store.deactivateUser(actor(c.get('user')), c.req.param('key'));
      return c.json({ deleted: true });
    })
    .get('/admin/groups/unmanaged', async (c) =>
      c.json({ groups: await store.listUnmanagedGroups(actor(c.get('user'))) }))
    // Recovery promotes one of the Group's own members, never anybody else.
    .post('/admin/groups/:key/recover', validator('json', (value) => {
      const input = record(value, ['userKey']);
      return { userKey: requiredText(input.userKey, 'userKey') };
    }), async (c) => {
      await store.appointGroupManager(actor(c.get('user')), c.req.param('key'), c.req.valid('json').userKey);
      return c.json({ ok: true });
    })
    .get('/settings', async (c) => c.json({ settings: await store.settings() }))
    .patch('/settings', async (c) => c.json({ settings: await store.updateSettings(actor(c.get('user')), await c.req.json()) }))
    // What this Kannabi was built with. Composition is static, so this is an
    // inventory to read and never a place to install or enable anything:
    // whoever can install a plugin can read every Asset, and administration
    // grants no Asset access.
    .get('/admin/plugins', async (c) => {
      if (!await store.isAdministrator(actor(c.get('user')))) {
        throw new AdministrationError('Administrator access required');
      }
      return c.json({ contract: pluginContract, plugins: plugins.manifests });
    })
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
      const input = record(JSON.parse(String(form.get('report'))), ['name', 'identifiers', 'ownerKey', 'groupKey', 'sourceRecord']);
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
    // The People directory, and individual User profiles, share one boundary:
    // the instance's People directory setting, for approved accounts only.
    // A search narrows it; there is no paging through the whole instance.
    .get('/people', async (c) => {
      const limit = c.req.query('limit');
      return c.json(await store.listPeople(actor(c.get('user')), {
        query: c.req.query('q') ?? null, limit: limit === undefined ? undefined : Number(limit) }));
    })
    // A User page, for somebody the viewer can already find. It grants no Asset
    // access: the count it shows is counted through the viewer's own
    // readability, and an unreachable person is absent rather than refused.
    .get('/users/:key', async (c) => {
      const profile = await store.userProfile(actor(c.get('user')), c.req.param('key'));
      if (!profile) return c.json({ error: 'User not found' }, 404);
      return c.json({ profile });
    })
    .get('/groups', async (c) => c.json({ groups: await store.listMyGroups(actor(c.get('user'))) }))
    .post('/groups', validator('json', (value) => {
      const input = record(value, ['name']);
      return { name: requiredText(input.name, 'name') };
    }), async (c) => c.json({ group: await store.createReportingGroup(c.req.valid('json').name, actor(c.get('user'))) }, 201))
    // A Group as the viewer stands in it, answered only to its members and
    // otherwise exactly as for an unknown Group.
    .get('/groups/:key', async (c) =>
      c.json(await store.groupRelationship(actor(c.get('user')), c.req.param('key'))))
    // A Group's people and their roles, for any of its members. Adding,
    // changing a role and removing are its Group Managers'.
    .get('/groups/:key/members', async (c) => c.json({
      members: await store.listGroupMembers(actor(c.get('user')), c.req.param('key')) }))
    .post('/groups/:key/members', validator('json', (value) => {
      const input = record(value, ['userKey', 'role']);
      return { userKey: requiredText(input.userKey, 'userKey'),
        role: input.role === undefined ? 'member' as const : groupRole(input.role) };
    }), async (c) => {
      const { userKey, role } = c.req.valid('json');
      const added = await store.addGroupMember(actor(c.get('user')), c.req.param('key'), userKey, role);
      return c.json({ ok: true, added });
    })
    .patch('/groups/:key/members/:userKey', validator('json', (value) =>
      ({ role: groupRole(record(value, ['role']).role) })), async (c) => c.json(
      await store.setMemberRole(actor(c.get('user')), c.req.param('key'), c.req.param('userKey'),
        c.req.valid('json').role)))
    .delete('/groups/:key/members/:userKey', async (c) => c.json(
      await store.removeGroupMember(actor(c.get('user')), c.req.param('key'), c.req.param('userKey'))))
    .delete('/groups/:key/membership', async (c) => {
      await store.leaveGroup(actor(c.get('user')), c.req.param('key'));
      return c.json({ ok: true });
    })
    .get('/assets', async (c) => {
      const key = actor(c.get('user'));
      // Every value of every parameter: `group` and `scheme` repeat, and
      // `query()` keeps only the first, so the request would apply less than
      // the URL asks for.
      return c.json(await store.findAssets(key, assetPageRequest(c.req.queries(), store.schemes.ids)));
    })
    // The structured Asset representation, at its own versioned paths so the
    // routes above keep answering every existing client exactly as before. The
    // same reads, the same readability and the same parsers; only the shape of
    // the answer differs. Registered before /assets/:id has any chance to see
    // a "v3" segment, which would not parse as an Asset ID anyway.
    .get('/v3/assets', async (c) => {
      const page = await store.findAssets(actor(c.get('user')), assetPageRequest(c.req.queries(), store.schemes.ids));
      return c.json({ representation: assetRepresentation, omitted: summaryOmits,
        assets: page.assets.map((asset) => assetSummary(asset, page.matchedFields[asset.id] ?? [])),
        matching: page.matching, total: page.total, nextCursor: page.nextCursor });
    })
    .get('/v3/assets/lookup', validator('query', (value) =>
      assetLookupQuery(value as Record<string, unknown>, store.schemes)), async (c) => {
      const lookup = await store.lookupAssets(c.get('user')?.key ?? publicAudience, c.req.valid('query'));
      return c.json({ representation: assetRepresentation, identity: lookup.identity, omitted: summaryOmits,
        assets: lookup.assets.map((asset) => assetSummary(asset)), matching: lookup.matching,
        nextCursor: lookup.nextCursor });
    })
    .get('/v3/assets/:id', async (c) => {
      const audience = c.get('user')?.key ?? null;
      const asset = await store.getAsset(assetId(c.req.param('id')), audience);
      if (!asset) return c.json({ error: 'Asset not found' }, 404);
      return c.json({ representation: assetRepresentation,
        asset: assetRecord(asset, store.schemes, await plugins.sections(asset, audience)) });
    })
    // Registered before /assets/:id so the static segment wins. Deterministic
    // identity resolution, deliberately separate from free-text browsing: an
    // identity that is unreadable answers exactly as one that does not exist.
    //
    // Anonymous callers are answered as the public audience, exactly as
    // /assets/:id already is. A public Asset is readable through its public
    // URI, and an address a scheme supplies is one of those, so requiring a
    // session here would make a public Asset unreachable by an address
    // Kannabi prints for it. Lookup still runs over the reader-visible set,
    // so this widens who may ask and never what any reader may see.
    .get('/assets/lookup', validator('query', (value) =>
      assetLookupQuery(value as Record<string, unknown>, store.schemes)), async (c) =>
      c.json(await store.lookupAssets(c.get('user')?.key ?? publicAudience, c.req.valid('query'))))
    .post('/assets', validator('json', (value) => {
      const input = record(value, ['name', 'identifiers', 'ownerKey', 'groupKey', 'sourceRecord']);
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
      const canViewReporterProfile = user
        ? await store.userProfile(user.key, asset.reportedBy.key) !== null
        : false;
      return c.json({ asset, canEdit: groups.some((g) => asset.groups.some((access) => access.key === g.key)),
        canViewReporterProfile,
        // Derived on every read, never stored, and added beside `asset.id`
        // rather than in place of it: `asset.id` is the stable address, and
        // these follow whichever identifiers the Asset currently carries.
        // An identifier gets one only where its scheme supplies an address
        // Kannabi dereferences.
        addresses: asset.identifiers.flatMap((identifier) => {
          const path = store.schemes.address(identifier);
          return path === null ? [] : [{ identifierKey: identifier.key, canonical: identifier.canonical,
            uri: origin.replace(/\/$/, '') + path }];
        }),
        // The address put in front of a person: one an installed plugin
        // surfaces for this Asset, or its native URI.
        surfacedUri: new URL(plugins.surfaced(asset) ?? assetPath(asset.id), origin).toString(),
        // Each installed plugin's statement about this Asset, as the
        // structured representation carries it.
        extensions: await plugins.sections(asset, user?.key ?? null) });
    })
    .patch('/assets/:id', validator('json', (value) =>
      record(value, ['name', 'ownerKey', 'isPublic']) as AssetChanges), async (c) => {
      const asset = await store.updateAsset(assetId(c.req.param('id')), c.req.valid('json'),
        actor(c.get('user')), changeOrigin(c));
      return c.json({ asset });
    })
    .put('/assets/:id/collaboration/:groupKey', async (c) => c.json(
      await store.setAssetCollaboration(assetId(c.req.param('id')), actor(c.get('user')),
        c.req.param('groupKey'), true, changeOrigin(c))))
    .delete('/assets/:id/collaboration/:groupKey', async (c) => c.json(
      await store.setAssetCollaboration(assetId(c.req.param('id')), actor(c.get('user')),
        c.req.param('groupKey'), false, changeOrigin(c))))
    // Attach an existing external identifier. This validates it through its
    // scheme and never claims Kannabi issued it. Knowing an identifier grants
    // no Asset access.
    .post('/assets/:id/identifiers', validator('json', (value) =>
      record(value, store.schemes.inputFields) as Record<string, string>), async (c) => {
      const asset = await store.attachIdentifier(assetId(c.req.param('id')), actor(c.get('user')),
        c.req.valid('json'), changeOrigin(c));
      return c.json({ asset }, 201);
    })
    .delete('/assets/:id/identifiers/:key', async (c) => {
      const asset = await store.detachIdentifier(assetId(c.req.param('id')), actor(c.get('user')),
        c.req.param('key'), changeOrigin(c));
      return c.json({ asset });
    })
    .onError(refused);
  // Each installed plugin's routes, under its own id. They sit behind every
  // middleware above, so a plugin's route is authenticated, Origin-guarded and
  // answered for the same caller as core's own, and its refusals are rendered
  // by the same handler.
  const api = new Hono<Env>().route('/', core).onError(refused);
  for (const { id, app } of plugins.http) api.route(`/${id}`, app);
  return Object.assign(api, { core });
}
/** Core's own routes, which is what a typed client of core is typed by. A
 * plugin's routes are mounted at run time and typed by the plugin's own
 * client. */
export type InventoryApi = ReturnType<typeof createInventoryApi>['core'];
