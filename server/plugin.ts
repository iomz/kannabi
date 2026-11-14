import type { Hono } from 'hono';
import type { Driver, ManagedTransaction, Session } from 'neo4j-driver';
import type { AudienceInput, NamedAudienceInput } from './asset-audience.js';
import type { HttpEnv } from './http-context.js';
import type { Identifier, IdentifierRule, IdentifierScheme, IdentifierSchemes } from './identifier.js';
import { identifierSchemes } from './identifier.js';
import type { Asset, IdentityStore } from './identity-store.js';

/** The contract between Kannabi core and a plugin.
 *
 * A plugin is a capability that one deployment has and another wholly lacks.
 * Composition is static: `composition.ts` names the installed plugins, and a
 * deployment without one is that file without it. There is no discovery, no
 * runtime loading and no enable flag.
 *
 * A plugin adds and never overrides. Nothing here lets one replace or skip
 * authorization, provenance, the Asset access predicate or the Origin guard:
 * routes are mounted behind core's own authentication, an address a plugin
 * claims is still served only to a reader who may see the Asset, and inside an
 * Asset write a plugin may refuse but core does the writing.
 *
 * Plugins are trusted code in the same process and the same database. The
 * contract is enforced by its shape, by review and by startup verification,
 * never by a sandbox.
 */

/** The version of this contract. Its own number, independent of the Kannabi
 * release, as the MCP interface version and a scheme's policy version are.
 * It changes when a plugin written against the previous one would no longer
 * work unchanged. */
export const pluginContract = 1;

/** What a plugin says about itself. Read by startup and by the Plugins page;
 * nothing here is behaviour. */
export type PluginManifest = Readonly<{
  /** Lowercase. Namespaces the plugin's routes, node labels and
   * representation section. */
  id: string;
  name: string;
  version: string;
  /** The contract versions this plugin was written against. Startup refuses a
   * plugin whose list does not include the running one. */
  contract: readonly number[];
  /** The ids of the plugins this one calls. */
  requires: readonly string[];
  /** What it adds, in plain words, for whoever reads the Plugins page. */
  contributes: readonly string[];
}>;

/** A uniqueness constraint over a plugin's own nodes. The label carries the
 * plugin's id as its prefix, so two plugins can never claim the same one. */
export type PluginConstraint = Readonly<{ name: string; label: string; properties: readonly string[] }>;

export type PluginPersistence = Readonly<{
  constraints: readonly PluginConstraint[];
  /** Bring the plugin's own data forward. Runs when the database is opened
   * for writing, after its constraints exist and before core verifies what it
   * stores. Idempotent, and safe against a concurrently starting peer. */
  migrate?(driver: Driver): Promise<void>;
  /** Startup invariants over the plugin's own data. Read-only: it also runs
   * for a process that attaches without writing. */
  verify?(session: Session): Promise<void>;
}>;

/** A plugin's part in a write that changes an Asset's identifiers.
 *
 * The one contribution admitted on the strength of a core invariant rather
 * than of two plugins needing it: a rule that must hold in the same
 * transaction as the write cannot be applied anywhere else. Core opens the
 * transaction, evaluates authorization, locks the Asset, attaches and stamps
 * provenance. A participant reads and writes only its own data, and may
 * refuse the write by throwing.
 */
export type AssetWriteParticipant = Readonly<{
  /** Before `additions` join `existing` on the Asset. Empty `existing` and a
   * new `assetId` describe an Asset being reported. */
  beforeIdentifiers(tx: ManagedTransaction, write: Readonly<{
    assetId: string; existing: readonly Identifier[]; additions: readonly Identifier[];
  }>): Promise<void>;
  /** After the Asset's identifiers changed, by attachment or detachment. */
  afterIdentifiers(tx: ManagedTransaction, assetId: string): Promise<void>;
}>;

/** What a root-level path names, as the plugin that claims it reads it. The
 * plugin says which Asset, if any; core decides whether the reader may see it,
 * so an unreadable Asset stays indistinguishable from an unknown address. */
export type AddressClaim =
  | Readonly<{ kind: 'identifier'; identifier: Identifier }>
  | Readonly<{ kind: 'asset'; id: string }>
  | Readonly<{ kind: 'notFound' }>
  | Readonly<{ kind: 'invalid'; message: string }>;

export type AddressResolver = Readonly<{
  /** Read a raw, still-encoded request path. Null means the path is not this
   * plugin's, and routing carries on. */
  claim(rawPath: string): AddressClaim | null;
  /** The address to put in front of a person for this Asset in place of its
   * native URI, or null for none. Presentation only: the native URI stays
   * valid, and the address returned must be one this plugin claims. */
  surfaced?(asset: Readonly<{ id: string; identifiers: readonly Identifier[] }>): string | null;
}>;

/** One read-only tool. The handler is given the audience core resolved for
 * the request and never the request itself. */
export type McpTool = Readonly<{
  name: string;
  title: string;
  description: string;
  /** Zod object schemas. Typed loosely here so the contract does not pin a
   * plugin to core's copy of the schema library's types. */
  inputSchema?: unknown;
  outputSchema: unknown;
  handler(input: Record<string, unknown>, audience: NamedAudienceInput): Promise<unknown>;
}>;

export type McpContribution = Readonly<{
  /** One paragraph stating what this plugin knows and where that stops. */
  instructions: string;
  tools: readonly McpTool[];
}>;

/** What a plugin is before anything is running: what it stores, which schemes
 * it brings and how it takes part in a write. Needed to open the database, so
 * it cannot depend on the open store. */
export type PluginDefinition<Api = unknown> = Readonly<{
  manifest: PluginManifest;
  schemes?: readonly IdentifierScheme[];
  rules?: readonly IdentifierRule[];
  persistence?: PluginPersistence;
  participant?: AssetWriteParticipant;
  /** Build the running plugin around the open store and the peers it named. */
  connect(core: IdentityStore, peers: Readonly<Record<string, unknown>>): PluginRuntime<Api>;
}>;

export type PluginRuntime<Api = unknown> = Readonly<{
  /** What other plugins may call. */
  api: Api;
  /** Mounted at `/api/<id>/`, behind core's authentication and Origin guard. */
  http?: Hono<HttpEnv>;
  addresses?: AddressResolver;
  mcp?: McpContribution;
  /** This plugin's statements about one Asset, placed under `extensions.<id>`
   * in the Asset representation. Called only for an Asset the audience may
   * already read, and follows that Asset's visibility whole: it is never
   * filtered by who is asking. A plugin whose data must not follow the Asset
   * contributes no section and serves that data from its own routes. */
  assetSection?(asset: Asset, audience: AudienceInput): Promise<unknown>;
}>;

/** The installed plugins before the store is open: everything `IdentityStore`
 * needs to open the database and to run a write. */
export type Composition = Readonly<{
  schemes: IdentifierSchemes;
  plugins: readonly PluginDefinition[];
}>;

export function compose(plugins: readonly PluginDefinition[]): Composition {
  const seen = new Set<string>();
  for (const { manifest } of plugins) {
    if (!/^[a-z][a-z0-9-]*$/.test(manifest.id)) throw new Error(`Plugin id "${manifest.id}" is not a lowercase token`);
    if (seen.has(manifest.id)) throw new Error(`Plugin "${manifest.id}" is installed twice`);
    if (!manifest.contract.includes(pluginContract)) {
      throw new Error(`Plugin "${manifest.id}" supports plugin contract ${manifest.contract.join(', ') || 'none'}, `
        + `and this Kannabi runs contract ${pluginContract}`);
    }
    // A peer is an ordinary earlier entry, so a plugin can never be handed one
    // that has not been built yet.
    const missing = manifest.requires.find((id) => !seen.has(id));
    if (missing !== undefined) throw new Error(`Plugin "${manifest.id}" requires "${missing}" to be installed before it`);
    seen.add(manifest.id);
  }
  return Object.freeze({
    schemes: identifierSchemes(plugins.flatMap((plugin) => plugin.schemes ?? []),
      plugins.flatMap((plugin) => plugin.rules ?? [])),
    plugins: Object.freeze([...plugins]),
  });
}

/** The installed plugins, running. Built once the store is open and handed to
 * whatever serves a surface. */
export type Plugins = Readonly<{
  manifests: readonly PluginManifest[];
  /** Each plugin's `api`, by id. */
  apis: Readonly<Record<string, unknown>>;
  http: readonly Readonly<{ id: string; app: Hono<HttpEnv> }>[];
  mcp: readonly McpContribution[];
  /** The first claim any plugin makes on a path, or null when none does. */
  claim(rawPath: string): AddressClaim | null;
  /** The address surfaced for an Asset in place of its native URI, or null. */
  surfaced(asset: Readonly<{ id: string; identifiers: readonly Identifier[] }>): string | null;
  /** Every plugin's section for one Asset, keyed by plugin id. Empty when no
   * plugin contributes one. */
  sections(asset: Asset, audience: AudienceInput): Promise<Readonly<Record<string, unknown>>>;
}>;

export function connectPlugins(composition: Composition, store: IdentityStore): Plugins {
  const apis: Record<string, unknown> = {};
  const running = composition.plugins.map((definition) => {
    const peers = Object.fromEntries(definition.manifest.requires.map((id) => [id, apis[id]]));
    const runtime = definition.connect(store, peers);
    apis[definition.manifest.id] = runtime.api;
    return { id: definition.manifest.id, runtime };
  });
  const resolvers = running.flatMap(({ runtime }) => (runtime.addresses ? [runtime.addresses] : []));
  const sectioned = running.flatMap(({ id, runtime }) =>
    (runtime.assetSection ? [{ id, section: runtime.assetSection }] : []));
  return Object.freeze({
    manifests: composition.plugins.map((plugin) => plugin.manifest),
    apis,
    http: running.flatMap(({ id, runtime }) => (runtime.http ? [{ id, app: runtime.http }] : [])),
    mcp: running.flatMap(({ runtime }) => (runtime.mcp ? [runtime.mcp] : [])),
    claim(rawPath: string) {
      for (const resolver of resolvers) {
        const claim = resolver.claim(rawPath);
        if (claim !== null) return claim;
      }
      return null;
    },
    surfaced(asset) {
      for (const resolver of resolvers) {
        const path = resolver.surfaced?.(asset) ?? null;
        if (path !== null) return path;
      }
      return null;
    },
    async sections(asset, audience) {
      const entries = await Promise.all(sectioned.map(async ({ id, section }) =>
        [id, await section(asset, audience)] as const));
      return Object.fromEntries(entries);
    },
  });
}

/** Kannabi with nothing installed. An Asset is still complete: carrying no
 * identifier is an ordinary state. */
export const noPlugins: Plugins = Object.freeze({
  manifests: [], apis: {}, http: [], mcp: [],
  claim: () => null, surfaced: () => null, sections: async () => ({}),
});
