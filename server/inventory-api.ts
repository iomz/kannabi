import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { validator } from 'hono/validator';
import { isAPIError } from 'better-auth/api';
import { assetPageRequest } from './asset-page.js';
import { maxPhotoBytes, type MediaService } from './media.js';
import type { Auth } from './auth.js';
import { canonicalIdentifier, record, requiredText, ValidationError } from './identity.js';
import { AdministrationError, LastAdministratorError, DuplicateIdentityError, ReferenceError, type IdentityStore, type AssetChanges, type ReportAsset } from './identity-store.js';
import { MailDeliveryError, MailRevisionConflictError, type MailService } from './mail.js';
import { SecretUnavailableError } from './secrets.js';

type User = { key: string; name: string };
type Env = { Variables: { user: User | null } };
const authPaths = new Set(['/api/auth/sign-up/email', '/api/auth/sign-in/email', '/api/auth/sign-out',
  '/api/auth/get-session', '/api/auth/change-password', '/api/auth/request-password-reset', '/api/auth/reset-password']);
function actor(user: User | null) {
  if (!user) throw new HTTPException(401, { message: 'Sign in required' });
  return user.key;
}

function memberAuthError(error: unknown, fallback: string): never {
  if (!isAPIError(error)) throw error;
  if (error.statusCode === 401) throw new HTTPException(401, { message: 'Sign in required' });
  if (error.statusCode === 403) throw new AdministrationError('Administrator access required');
  throw new HTTPException(error.statusCode === 409 ? 409 : 400, { message: fallback });
}

export function createInventoryApi(store: IdentityStore, auth: Auth, origin: string, media?: MediaService, mail?: MailService) {
  return new Hono<Env>()
    .use('*', async (c, next) => {
      c.header('Cache-Control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('Origin') !== origin) {
        return c.json({ error: 'Request origin not allowed' }, 403);
      }
      await next();
    })
    .use('*', bodyLimit({ maxSize: maxPhotoBytes + 16384 }))
    .all('/auth/*', (c) => authPaths.has(new URL(c.req.url).pathname)
      ? auth.handler(c.req.raw) : c.json({ error: 'Not found' }, 404))
    .use('*', async (c, next) => {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      const key = session?.user.key;
      if (session && !key) throw new Error('Authenticated User has no domain key');
      c.set('user', session && key ? { key, name: session.user.name } : null);
      await next();
    })
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
      const asset = await media.report(report as ReportAsset, { actorKey, groupKey: requiredText(groupKey, 'groupKey') }, file && file.size ? file : undefined);
      return c.json({ asset }, 201);
    })
    .post('/photo', validator('query', canonicalIdentifier), async (c) => {
      const actorKey = actor(c.get('user'));
      if (!media) throw new HTTPException(503, { message: 'Media storage unavailable' });
      const form = await c.req.formData();
      const file = form.get('photo');
      if (!(file instanceof File)) throw new ValidationError('Expected a photo file');
      return c.json({ asset: await media.add(c.req.valid('query'), actorKey, file) }, 201);
    })
    .get('/photos/:key', validator('query', canonicalIdentifier), async (c) => {
      if (!media) throw new HTTPException(503, { message: 'Media storage unavailable' });
      const { photo, bytes } = await media.read(c.req.valid('query'), c.req.param('key'), c.get('user')?.key ?? null);
      c.header('Content-Type', photo.contentType);
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('Content-Disposition', 'inline');
      return c.body(new Uint8Array(bytes).buffer);
    })
    .delete('/photo/:key', validator('query', canonicalIdentifier), async (c) => {
      if (!media) throw new HTTPException(503, { message: 'Media storage unavailable' });
      await media.remove(c.req.valid('query'), actor(c.get('user')), c.req.param('key'));
      return c.json({ deleted: true });
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
    .post('/assets', validator('json', (value) => {
      const input = record(value, ['name', 'identifiers', 'ownerKey', 'groupKey']);
      return { ...input, groupKey: requiredText(input.groupKey, 'groupKey') } as ReportAsset & { groupKey: string };
    }), async (c) => {
      const actorKey = actor(c.get('user'));
      const { groupKey, ...report } = c.req.valid('json');
      const asset = await store.reportAsset(report, { actorKey, groupKey });
      return c.json({ asset }, 201);
    })
    .get('/asset', validator('query', canonicalIdentifier), async (c) => {
      const user = c.get('user');
      const asset = await store.getAsset(c.req.valid('query'), user?.key ?? null);
      if (!asset) return c.json({ error: 'Asset not found' }, 404);
      const groups = user ? await store.listGroups(user.key) : [];
      return c.json({ asset, canEdit: groups.some((g) => asset.groups.some((access) => access.key === g.key)) });
    })
    .patch('/asset', validator('query', canonicalIdentifier), validator('json', (value) =>
      record(value, ['name', 'ownerKey', 'isPublic']) as AssetChanges), async (c) => {
      const asset = await store.updateAsset(c.req.valid('query'), c.req.valid('json'), actor(c.get('user')));
      return c.json({ asset });
    })
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
