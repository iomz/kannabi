import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { assetId } from '../../../server/asset-id.js';
import type { ChangeOrigin } from '../../../server/change-provenance.js';
import { actor, administrativeCredential, changeOrigin, type HttpEnv } from '../../../server/http-context.js';
import { record, ValidationError } from '../../../server/identity.js';
import { ReferenceError } from '../../../server/identity-store.js';
import type { Gs1Store } from './store.js';
import type { IssuanceScheme } from '../toolkit/gs1.js';

/** The GS1 plugin's HTTP routes, mounted by core at `/api/gs1/`.
 *
 * Core has already authenticated the caller, applied the Origin guard and
 * resolved who is asking before any of these runs. Every authorization
 * decision is still made by the operation itself: knowing a namespace or a
 * class key grants nothing, and no route here reaches an Asset its caller's
 * Groups do not.
 */
export function createGs1Api(gs1: Gs1Store) {
  /** Issuance is idempotent per scheme: a repeat call returns the existing
   * issuance of that scheme and leaves any other scheme's alone. */
  const issue = async (scheme: IssuanceScheme, id: string, actorKey: string, request: unknown,
    origin: ChangeOrigin) => {
    const { issuances, ...asset } = await gs1.issueKey(assetId(id), actorKey, scheme, request, origin);
    return { asset, issuances };
  };

  return new Hono<HttpEnv>()
    // The plugin's settings are public to read, as core's are, and an
    // administrator's to change. The credential ceiling is applied here as
    // core applies it to its own settings.
    .get('/settings', async (c) => c.json({ settings: await gs1.settings() }))
    .patch('/settings', administrativeCredential, async (c) =>
      c.json({ settings: await gs1.updateSettings(actor(c.get('user')), await c.req.json()) }))
    // The Assets that block enforcing GTIN consistency, a page at a time. The
    // 409 refusing enforcement carries the first page; this continues it.
    .get('/admin/gtin-conflicts', administrativeCredential, async (c) => c.json({
      gtinConflicts: await gs1.gtinConflicts(actor(c.get('user')), c.req.query('after')),
    }))
    // The ledger rows bound to one Asset, for a reader who may see that Asset
    // and for nobody else: an unreadable Asset answers as an unknown one.
    .get('/assets/:id/issuances', async (c) => {
      const issuances = await gs1.readableIssuances(assetId(c.req.param('id')), c.get('user')?.key ?? null);
      if (issuances === null) throw new ReferenceError('Asset not found');
      return c.json({ issuances });
    })
    // A GIAI takes a namespace alone; a serialised GRAI and an SGTIN each name
    // the managed class key they are serialised under, which is exactly what a
    // merely recorded identifier can never supply.
    .post('/assets/:id/giai', validator('json', (value) => record(value, ['namespaceKey'])), async (c) =>
      c.json(await issue('giai', c.req.param('id'), actor(c.get('user')), c.req.valid('json'), changeOrigin(c))))
    .post('/assets/:id/grai', validator('json', (value) =>
      record(value, ['namespaceKey', 'classKeyKey'])), async (c) =>
      c.json(await issue('grai', c.req.param('id'), actor(c.get('user')), c.req.valid('json'), changeOrigin(c))))
    .post('/assets/:id/sgtin', validator('json', (value) =>
      record(value, ['namespaceKey', 'classKeyKey'])), async (c) =>
      c.json(await issue('sgtin', c.req.param('id'), actor(c.get('user')), c.req.valid('json'), changeOrigin(c))))
    .get('/namespaces', async (c) =>
      c.json({ namespaces: await gs1.listGs1Namespaces(actor(c.get('user'))) }))
    .post('/groups/:key/namespaces', validator('json', (value) =>
      record(value, ['gcp', 'giaiExclusions', 'graiTypeExclusions', 'gtinItemExclusions'])), async (c) =>
      c.json({ namespace: await gs1.configureGs1Namespace(actor(c.get('user')),
        c.req.param('key'), c.req.valid('json')) }, 201))
    .patch('/namespaces/:key', validator('json', (value) => {
      const input = record(value, ['active']);
      if (typeof input.active !== 'boolean') throw new ValidationError('Namespace active state must be a boolean');
      return { active: input.active };
    }), async (c) => c.json({ namespace: await gs1.setGs1NamespaceActive(actor(c.get('user')),
      c.req.param('key'), c.req.valid('json').active) }))
    // Class keys are namespace configuration rather than Asset work: managing
    // one touches no Asset and grants no Asset access.
    .get('/namespaces/:key/class-keys', validator('query', (value) => {
      const input = record(value as Record<string, unknown>, ['scheme']);
      if (input.scheme !== undefined && input.scheme !== 'grai' && input.scheme !== 'gtin') {
        throw new ValidationError('A managed class key is a GTIN or a GRAI asset type');
      }
      return { scheme: input.scheme as 'grai' | 'gtin' | undefined };
    }), async (c) => c.json({ classKeys: await gs1.listClassKeys(actor(c.get('user')),
      c.req.param('key'), c.req.valid('query').scheme) }))
    // One route for allocation and adoption, because the difference is a
    // single recorded fact: supplying the key's own value is what makes it an
    // adoption, and the stored provenance says which it was.
    .post('/namespaces/:key/class-keys', validator('json', (value) =>
      record(value, ['scheme', 'gtin', 'serial', 'assetType', 'assetReference', 'serialExclusions'])),
    async (c) => c.json({ classKey: await gs1.manageClassKey(actor(c.get('user')),
      c.req.param('key'), c.req.valid('json')) }, 201))
    .patch('/namespaces/:key/class-keys/:classKeyKey', validator('json', (value) => {
      const input = record(value, ['active']);
      if (typeof input.active !== 'boolean') throw new ValidationError('Class key active state must be a boolean');
      return { active: input.active };
    }), async (c) => c.json({ classKey: await gs1.setClassKeyActive(actor(c.get('user')),
      c.req.param('classKeyKey'), c.req.valid('json').active) }));
}
export type Gs1Api = ReturnType<typeof createGs1Api>;
