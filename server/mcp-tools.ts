import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { assetPageRequest, assetSorts, assetDirections } from './asset-page.js';
import { assetLookupQuery } from './asset-lookup.js';
import { isAssetId } from './asset-id.js';
import { assetRecord, assetSummary, notRecorded, summaryOmits } from './asset-representation.js';
import { ValidationError } from './identity.js';
import { PrincipalError, type AudienceResolver } from './mcp-principal.js';
import { ReferenceError as DomainReferenceError, type IdentityStore } from './identity-store.js';
import { noPlugins, type McpTool, type Plugins } from './plugin.js';

/** Kannabi's domain MCP surface.
 *
 * Every tool answers a question Kannabi owns the answer to: which Assets it
 * knows, which identities address them and which Groups exist, together with
 * whatever each installed plugin owns the answer to. Nothing here proxies
 * another information source, and nothing here exposes the graph as a
 * graph: events, observations and arbitrary traversal belong to their own
 * systems and their own MCP servers.
 *
 * The tools are read-only. They call the same domain operations the web API
 * calls, so identity, readability and provenance semantics cannot drift between
 * the two surfaces.
 *
 * Reads run under the system audience: this process sees every Asset,
 * regardless of the User/Group readability that governs the web application.
 * See `asset-audience.ts`.
 */

const identifierLevels = {
  individual: 'identifies exactly one Asset',
  class: 'describes a class of Assets, so it may address several',
} as const;

const entitySchema = z.object({ key: z.string(), name: z.string() });
const credentialSchema = z.object({ id: z.string(), label: z.string() })
  .describe('The API credential that asserted it, with the label it carried then. Null when a person acted directly.');
const basisSchema = z.string().nullable()
  .describe('The opaque reference the request named as its basis, such as a source row. A reference, not evidence.');

const identifierSchema = z.object({
  scheme: z.string().describe('The identifier scheme that accepted the value.'),
  value: z.string().describe('The identifier in its scheme\'s canonical form.'),
  level: z.enum(['individual', 'class'])
    .describe('"individual" identifies this one Asset; "class" names a kind of thing other Assets may carry too.'),
  components: z.record(z.string(), z.string())
    .describe('The arguments resolve_external_identifier takes for this identity, unchanged.'),
});

export const attributionSchema = z.object({
  key: z.string(), name: z.string(), status: z.enum(['active', 'deleted']),
}).describe('Who acted, as immutable provenance. "deleted" means the account is gone and only the name was kept. Never an indication of who may access the Asset.');

const actSchema = z.object({
  at: z.string(), by: attributionSchema, via: credentialSchema.nullable(), basis: basisSchema,
});

const assetRecordSchema = z.object({
  id: z.string().describe('The native Kannabi Asset ID: the handle get_asset takes, meaningful only inside Kannabi.'),
  kannabi: z.object({
    name: z.string(),
    owner: entitySchema.nullable(),
    groups: z.array(entitySchema).describe('The Groups collaborating on the Asset. Keys narrow search_assets.'),
    public: z.boolean(),
    reported: z.object({ at: z.string(), by: attributionSchema }),
    lastChange: actSchema.nullable().describe('The latest change only, never a history.'),
    photos: z.array(z.object({
      key: z.string(), contentType: z.string(), size: z.number(), receivedAt: z.string().nullable(),
    })),
  }),
  identifiers: z.array(identifierSchema.extend({
    accepted: actSchema.extend({
      policy: z.string().describe('The version of the scheme\'s policy that accepted the value. Historical: never a claim that today\'s policy would.'),
    }).nullable()
      .describe('Who accepted this identifier onto this Asset: an acceptance, not a verification. Null for one accepted before Kannabi kept this.'),
    address: z.string().nullable()
      .describe('A path at which Kannabi dereferences this identifier, or null when its scheme supplies none.'),
  })),
  extensions: z.record(z.string(), z.unknown())
    .describe('What each installed plugin states about this Asset, keyed by plugin id. Each is that plugin\'s statement, described in the connection instructions; empty when none contributes.'),
  source: z.object({
    reference: z.string(),
    says: z.object({
      recordedAt: z.string().nullable(), recordedBy: z.string().nullable(), description: z.string().nullable(),
    }),
  }).nullable(),
  notRecorded: z.array(z.string()),
});

export const assetSummarySchema = z.object({
  id: z.string().describe('The native Kannabi Asset ID. Pass it to get_asset for the full record.'),
  kannabi: z.object({
    name: z.string(), owner: entitySchema.nullable(), groups: z.array(entitySchema), public: z.boolean(),
    reported: z.object({ at: z.string() }),
  }),
  identifiers: z.array(identifierSchema),
  source: z.object({ reference: z.string() }).nullable(),
  matched: z.array(z.string()).describe('Where the query text matched, as paths in the full record.'),
});

export const omittedSchema = z.array(z.string())
  .describe('Paths of the full record these summaries leave out. get_asset returns them.');

/** A tool result carries both renderings of the same value: the structured one
 * for the client, and its JSON text for models that only read content. */
function result<T>(value: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value };
}

function failed(error: unknown) {
  if (error instanceof PrincipalError || error instanceof ValidationError
    || error instanceof DomainReferenceError) {
    return { content: [{ type: 'text' as const, text: error.message }], isError: true };
  }
  throw error;
}

/** Turn typed tool arguments into the query record the shared request parsers
 * accept, so the MCP surface reuses Kannabi's validation rather than restating
 * it. Absent arguments are omitted, which is what "unset" means to a parser. */
export function queryRecord(entries: Record<string, string | string[] | number | undefined>) {
  return Object.fromEntries(Object.entries(entries)
    .filter(([, value]) => value !== undefined)
    .map(([field, value]) => [field, typeof value === 'number' ? String(value) : value]));
}

/** How this server identifies itself.
 *
 * `version` is the version of this MCP interface's contract, not a Kannabi
 * release: the repository ships no application version, and publishing one
 * here would assert a product version Kannabi does not have. Bump it when the
 * tool surface or its semantics change.
 */
export const serverInfo = {
  name: 'kannabi',
  title: 'Kannabi Asset registry',
  version: '0.4.0',
} as const;

/** What a client learns before it calls anything.
 *
 * An agent reaching this server knows nothing about Kannabi. The tool
 * descriptions can say how each tool behaves, but only this can say what
 * Kannabi is for and, more importantly, where its knowledge stops: without
 * that, an empty Asset search reads as "no such thing exists" rather than
 * "Kannabi was never told". Naming the boundary is what keeps an agent from
 * answering a question Kannabi has no standing to answer.
 */
const knowledgeBoundary = `Kannabi is an Asset registry and an identity mediator: it records physical things and the identities by which each one is known. Every tool is read-only.

An Asset record says whose statement each value is:
- kannabi: what Kannabi holds and did, by its own clock. kannabi.reported.at is when Kannabi recorded the Asset — for one loaded from another system, the load — and is the only Asset chronology.
- source.says: what the pre-existing record named by source.reference states about itself, quoted exactly. Report it as that source's statement, never as a fact Kannabi holds.
- extensions: what each installed plugin states about the Asset, keyed by plugin id. Each plugin describes its own section below; with none installed it is empty.
- notRecorded: ${notRecorded.join(', ')}. Kannabi does not own these facts; they belong to other systems, such as an EPCIS repository for events. Say Kannabi does not record them rather than inferring them from other fields.
A field Kannabi holds no value for is null; that is not evidence about the world. Search and lookup return summaries and name the paths they omit; get_asset returns the full record.

Choosing a tool: a description such as "the inspection camera" -> search_assets; an Asset id -> get_asset; a complete external identifier -> resolve_external_identifier, which exists when an identifier scheme is installed; list_groups supplies the Group keys search_assets takes.

Identifiers: an Asset may carry none, one or several, each belonging to a scheme an installed plugin supplies. A class-level identifier describes a class and may be carried by several Assets; an individual-level one identifies at most one. Kannabi core records identifiers and issues none: whether a value was issued, and by whom, is the statement of the plugin that issued it.`;

/** The connection instructions for a server reading under `reach`. How far a
 * result reaches is the one part that depends on how the server was built, so
 * it comes from the audience rule rather than being written here. Each
 * installed plugin adds one paragraph stating its own knowledge boundary. */
export const instructions = (reach: string, plugins: Plugins = noPlugins): string => [
  knowledgeBoundary,
  ...plugins.mcp.map((contribution) => contribution.instructions),
  reach,
].join('\n\n');

/** Build the server around a store and a rule for whose view each request runs
 * under. The rule is a parameter rather than a mode flag read here, so the
 * tools are identical whether this process reads the whole instance or acts as
 * one User: only the audience they are handed differs. */
export function createMcpServer(store: IdentityStore, resolveAudience: AudienceResolver,
  plugins: Plugins = noPlugins): McpServer {
  const server = new McpServer(serverInfo, { capabilities: { tools: {} },
    instructions: instructions(resolveAudience.reach, plugins) });
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
  const schemeIds = store.schemes.ids;
  // The fields a caller may supply across every installed scheme. What each
  // means is its scheme's to say, in the owning plugin's instructions.
  const schemeFields = store.schemes.inputFields.filter((field) => field !== 'scheme');

  server.registerTool('search_assets', {
    title: 'Search Assets',
    description: [
      'Find Assets by a case-insensitive substring of kannabi.name or source.says.description, and by',
      'the filters below. It never ranks, guesses or infers. Returns summaries for narrowing candidates;',
      'get_asset returns the full record. The cursor is bound to this query\'s filters and ordering, so',
      'only limit may change between pages.',
    ].join(' '),
    inputSchema: z.object({
      query: z.string().max(200).optional()
        .describe('Substring of kannabi.name or source.says.description. Omit to browse everything.'),
      groupKeys: z.array(z.string()).optional()
        .describe('Restrict to Assets a listed Group collaborates on. Keys come from list_groups.'),
      schemes: z.array(z.string()).optional()
        .describe(`Restrict to Assets carrying an identifier in one of these schemes. Installed: ${schemeIds.join(', ') || 'none'}.`),
      identified: z.enum(['any', 'none']).optional()
        .describe('"any": Assets with at least one external identifier. "none": Assets with none.'),
      reportedFrom: z.string().optional()
        .describe('Lower bound on kannabi.reported.at, as an ISO date or instant.'),
      reportedTo: z.string().optional()
        .describe('Upper bound on kannabi.reported.at. A plain date covers that whole day.'),
      sort: z.enum(assetSorts).optional().describe('Default "name". "reportedAt" orders by kannabi.reported.at.'),
      direction: z.enum(assetDirections).optional().describe('Default "asc".'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size, default 30.'),
      cursor: z.string().optional().describe('nextCursor from the previous page of this same query.'),
    }),
    outputSchema: z.object({
      omitted: omittedSchema,
      assets: z.array(assetSummarySchema).describe('This page of candidates, in the requested order.'),
      matching: z.number().int()
        .describe('Assets matching the whole query, not just this page. Zero means nothing matched what was asked.'),
      total: z.number().int()
        .describe('Assets this server holds in total, ignoring the query. With matching 0 it separates "nothing matched" from "Kannabi holds nothing".'),
      nextCursor: z.string().nullable()
        .describe('Pass back as cursor for the next page, or null when this page is the last. Opaque: never parse or construct one.'),
    }),
    annotations: readOnly,
  }, async (input, ctx) => {
    try {
      const audience = await resolveAudience(ctx.mcpReq._meta);
      const request = assetPageRequest(queryRecord({
        q: input.query, group: input.groupKeys, scheme: input.schemes, identified: input.identified,
        reportedFrom: input.reportedFrom, reportedTo: input.reportedTo,
        sort: input.sort, dir: input.direction, limit: input.limit, cursor: input.cursor,
      }), store.schemes.ids);
      const page = await store.findAssets(audience, request);
      return result({
        omitted: summaryOmits,
        assets: page.assets.map((asset) => assetSummary(asset, page.matchedFields[asset.id] ?? [])),
        matching: page.matching,
        total: page.total, nextCursor: page.nextCursor,
      });
    } catch (error) { return failed(error); }
  });

  // With no scheme installed there is no external identifier to resolve, and
  // the tool is absent rather than present and always refusing.
  if (schemeIds.length) server.registerTool('resolve_external_identifier', {
    title: 'Resolve an external identifier',
    description: [
      'Resolve one complete external identifier to the Assets that carry it. Exact and deterministic:',
      'the value is validated by its scheme and compared against the stored canonical form. Nothing is',
      'matched by substring or prefix.',
      'An individual-level identifier resolves to at most one Asset. A class-level identifier describes',
      'a class and may legitimately resolve to many, which are paged.',
      'An empty result means no Asset carries the identifier — it never means the value is invalid,',
      'which is reported as an error instead.',
      'This tool takes external identities only; a native Kannabi Asset ID goes to get_asset.',
      'Returns summaries; get_asset returns the full record.',
    ].join(' '),
    inputSchema: z.object({
      scheme: z.enum(schemeIds as readonly [string, ...string[]])
        .describe('The identifier scheme. Which fields each scheme takes is stated in the connection instructions.'),
      ...Object.fromEntries(schemeFields.map((field) => [field, z.string().optional()
        .describe(`A field of the chosen scheme, where that scheme takes one named ${field}.`)])),
      limit: z.number().int().min(1).max(100).optional().describe('Page size for a class identifier, default 30.'),
      cursor: z.string().optional().describe('nextCursor from the previous page for this same identifier.'),
    }),
    outputSchema: z.object({
      identity: z.object({
        scheme: z.string(),
        canonical: z.string().describe('The canonical form the input resolved to.'),
        level: z.enum(['individual', 'class']),
        levelMeaning: z.string()
          .describe('What this level means for the result count, so several Assets read as an answer rather than an ambiguity.'),
      }).describe('The identity as Kannabi understood it, echoed before any Asset was read, so it discloses nothing about what exists.'),
      omitted: omittedSchema,
      assets: z.array(assetSummarySchema).describe('The Assets carrying this identity. Empty means no Asset carries it.'),
      matching: z.number().int().describe('Assets carrying this identity in total, not just this page.'),
      nextCursor: z.string().nullable()
        .describe('Pass back as cursor for the next page of a class identity, or null when this page is the last.'),
    }),
    annotations: readOnly,
  }, async (input: Record<string, unknown>, ctx) => {
    try {
      const audience = await resolveAudience(ctx.mcpReq._meta);
      const { limit, cursor, ...identifier } = input;
      const request = assetLookupQuery({
        ...Object.fromEntries(Object.entries(identifier).filter(([, value]) => value !== undefined)),
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      }, store.schemes);
      const lookup = await store.lookupAssets(audience, request);
      if (lookup.identity.kind !== 'identifier') throw new ValidationError('An external identifier is required');
      const { canonical, scheme, level } = lookup.identity;
      return result({
        identity: { scheme, canonical, level, levelMeaning: identifierLevels[level] },
        omitted: summaryOmits,
        assets: lookup.assets.map((asset) => assetSummary(asset)),
        matching: lookup.matching,
        nextCursor: lookup.nextCursor,
      });
    } catch (error) { return failed(error); }
  });

  server.registerTool('get_asset', {
    title: 'Inspect an Asset',
    description: [
      'Return the full record of one Asset by its native Kannabi Asset ID, the id every other tool',
      'returns. The ID is not an external identifier and its embedded timestamp means nothing.',
      'Returns found: false when no such Asset exists.',
    ].join(' '),
    inputSchema: z.object({
      assetId: z.string().describe('A native Kannabi Asset ID: a lowercase UUIDv7.'),
    }),
    outputSchema: z.object({
      found: z.boolean()
        .describe('False when Kannabi holds no Asset with that ID. A well-formed ID that is not found is an answer, not an error.'),
      asset: assetRecordSchema.nullable(),
    }),
    annotations: readOnly,
  }, async ({ assetId }, ctx) => {
    try {
      const audience = await resolveAudience(ctx.mcpReq._meta);
      if (!isAssetId(assetId)) {
        throw new ValidationError('A native Kannabi Asset ID is required: the lowercase UUIDv7 that search_assets '
          + 'and resolve_external_identifier return as id. To find an Asset from a description, use search_assets; '
          + 'from an external identifier, use resolve_external_identifier.');
      }
      const asset = await store.getAsset(assetId, audience);
      return result({ found: asset !== null, asset: asset
        ? assetRecord(asset, store.schemes, await plugins.sections(asset, audience)) : null });
    } catch (error) { return failed(error); }
  });

  server.registerTool('list_groups', {
    title: 'List Groups',
    description: [
      'List the Kannabi Groups. A Group is the unit that collaborates on Assets, so its key is how',
      'search_assets narrows to a team, a site or a department by name, when a request names one.',
      'A Group key is a discovery vocabulary, not an access grant.',
    ].join(' '),
    outputSchema: z.object({
      groups: z.array(z.object({
        key: z.string().describe('Pass to search_assets.groupKeys to narrow to this Group.'),
        name: z.string().describe('The Group name a person would use, such as a team or site.'),
      })).describe('Every Group in this Kannabi instance, ordered by name.'),
    }),
    annotations: readOnly,
  }, async (ctx) => {
    try {
      const groups = await store.listGroups(await resolveAudience(ctx.mcpReq._meta));
      return result({ groups: groups.map((group) => ({ key: group.key, name: group.name })) });
    } catch (error) { return failed(error); }
  });

  // Each installed plugin's tools. The handler is given the audience this
  // server resolved, never the request, and its result and refusals are
  // rendered exactly as core's own are.
  const pluginTools: McpTool[] = plugins.mcp.flatMap((contribution) => [...contribution.tools]);
  for (const tool of pluginTools) {
    const config = { title: tool.title, description: tool.description,
      outputSchema: tool.outputSchema as z.ZodObject, annotations: readOnly };
    if (tool.inputSchema === undefined) {
      server.registerTool(tool.name, config, async (ctx) => {
        try { return result(await tool.handler({}, await resolveAudience(ctx.mcpReq._meta)) as Record<string, unknown>); }
        catch (error) { return failed(error); }
      });
    } else {
      server.registerTool(tool.name, { ...config, inputSchema: tool.inputSchema as z.ZodObject },
        async (input: Record<string, unknown>, ctx) => {
          try { return result(await tool.handler(input, await resolveAudience(ctx.mcpReq._meta)) as Record<string, unknown>); }
          catch (error) { return failed(error); }
        });
    }
  }

  return server;
}
