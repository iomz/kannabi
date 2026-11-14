import { readFile } from 'node:fs/promises';
import type { Context, Next } from 'hono';
import type { Auth } from './auth.js';
import type { IdentityStore } from './identity-store.js';
import { publicAudience, userAudience, type AssetAudience } from './asset-audience.js';
import { resolveClaimedAddress, resolveNativeAddress, type AssetResolver } from './address-resolution.js';
import type { Plugins } from './plugin.js';

/** The HTTP edge of address dereferencing.
 *
 * Kannabi's web application is a single-page build, so a document response has
 * no server render to carry a status. This middleware supplies the status and
 * the redirect, then hands a resolvable address straight back to the static
 * handler that already serves the application. An address that resolves is
 * therefore served exactly as it was before; only unresolvable and surfaced
 * addresses are answered here.
 *
 * It answers 400 for a claimed address its plugin reads as malformed and 404
 * for a well-formed one naming nothing the reader may see, because those are
 * correct HTTP. With no plugin installed only the native Asset URI is decided
 * here, and it never redirects.
 */

/** Only the native Asset URI may redirect, and only a whole path matches. */
const nativeAddress = /^\/asset\/([^/]+)\/?$/;

export function assetResolver(store: IdentityStore): AssetResolver {
  return {
    async assetForIdentifier(audience, identifier) {
      // Lookup already runs over the reader-visible set, so an identifier that
      // exists but is not readable comes back as no Assets at all.
      const { assets } = await store.lookupAssets(audience, {
        identity: Object.freeze({ kind: 'identifier' as const, identifier }), limit: 1, after: null,
      });
      return assets[0] ?? null;
    },
    assetById: (audience, id) => store.getAsset(id, audience),
  };
}

/** The reader a document request speaks for.
 *
 * A document navigation carries cookies and nothing else, so only a browser
 * session can name a reader here. Anything unexpected falls back to the
 * anonymous audience, which can only narrow what is visible.
 */
async function documentAudience(auth: Auth, headers: Headers): Promise<AssetAudience> {
  try {
    const session = await auth.api.getSession({ headers });
    const key = session?.user.key;
    return typeof key === 'string' && key ? userAudience(key) : publicAudience;
  } catch {
    return publicAudience;
  }
}

export function addressDocuments(store: IdentityStore, auth: Auth, plugins: Plugins, documentPath: string) {
  const resolver = assetResolver(store);
  let document: Promise<string> | null = null;
  const applicationDocument = () => (document ??= readFile(documentPath, 'utf8'));

  return async (c: Context, next: Next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    // Raw, still-encoded. A path decoded before it is split cannot tell a
    // separator from a %2F inside a value.
    const rawPath = c.req.path;
    const native = nativeAddress.exec(rawPath);
    const claim = native ? null : plugins.claim(rawPath);
    if (!native && claim === null) return next();

    const audience = await documentAudience(auth, c.req.raw.headers);
    const resolution = native
      ? await resolveNativeAddress(resolver, audience, decodeURIComponent(native[1]), plugins.surfaced)
      : await resolveClaimedAddress(resolver, audience, claim!);
    if (resolution.kind === 'render') return next();

    // Nothing about an address decision may be reused: attaching or detaching
    // an identifier changes the answer, and so does who is asking.
    c.header('Cache-Control', 'no-store');
    if (resolution.kind === 'redirect') {
      // Temporary, and method-preserving. The surfaced address can stop
      // serving the Asset at any moment, so 301 and 308 would invite a client to
      // rewrite a link that is not permanent, and 303 would claim the target
      // is a different resource when it is the same Asset.
      return c.redirect(resolution.location, 307);
    }
    return c.html(await applicationDocument(),
      resolution.kind === 'invalid' ? 400 : 404);
  };
}
