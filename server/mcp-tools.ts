import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { assetPageRequest, assetSorts, assetDirections } from './asset-page.js';
import { assetLookupQuery } from './asset-lookup.js';
import { giaiLedgerQuery } from './giai-ledger.js';
import { isAssetId } from './asset-id.js';
import { identifierSchemes } from './gs1.js';
import { ValidationError } from './identity.js';
import { systemAudience } from './asset-audience.js';
import {
  ReferenceError as DomainReferenceError, type Asset, type GiaiIssuance, type GiaiNamespace,
  type IdentityStore,
} from './identity-store.js';

/** Kannabi's domain MCP surface.
 *
 * Every tool answers a question Kannabi owns the answer to: which Assets it
 * knows, which identities address them, which Groups and GS1 Company Prefix
 * namespaces exist, and which values Kannabi itself issued. Nothing here
 * proxies another information source, and nothing here exposes the graph as a
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

/** A candidate, small enough to return many of. The native Asset ID is always
 * present, so any result can be carried into `get_asset` unambiguously. */
function summarise(asset: Asset) {
  return {
    assetId: asset.id,
    name: asset.name,
    isPublic: asset.isPublic,
    reportedAt: asset.reportedAt,
    groups: asset.groups.map((group) => ({ key: group.key, name: group.name })),
    owner: asset.owner ? { key: asset.owner.key, name: asset.owner.name } : null,
    identifiers: asset.identifiers.map((identifier) => ({
      scheme: identifier.scheme,
      canonical: identifier.canonical,
      level: identifier.level,
      // Carried here, not only in get_asset, because these are exactly the
      // arguments resolve_external_identifier takes: without them an agent
      // holding a search result cannot ask "what else carries this identity"
      // without a round trip whose only purpose is to reformat a value.
      components: identifier.components,
    })),
    // Present only when Kannabi's issuance ledger records the allocation.
    kannabiAllocatedGiai: asset.allocation ? asset.allocation.value : null,
    photoCount: asset.photos.length,
  };
}

const identifierSummarySchema = z.object({
  scheme: z.enum(identifierSchemes as readonly [string, ...string[]]),
  canonical: z.string()
    .describe('The GS1 element-string form, as Kannabi stores it, e.g. "(01)04901234567894".'),
  level: z.enum(['individual', 'class'])
    .describe('"individual": this value identifies this one Asset. "class": it describes a kind of thing and other Assets may carry it too.'),
  components: z.record(z.string(), z.string())
    .describe('The identifier\'s parts, named exactly as resolve_external_identifier\'s arguments, so this identity can be resolved again without reformatting.'),
});

const summarySchema = z.object({
  assetId: z.string().describe('The native Kannabi Asset ID. Pass it to get_asset; it means nothing outside Kannabi.'),
  name: z.string().describe('The human-given Asset name, and the only text search_assets matches.'),
  isPublic: z.boolean().describe('Whether the Asset is readable without signing in to Kannabi. Not a location, state or availability.'),
  reportedAt: z.string().describe('When this Asset was reported to Kannabi. This is the Asset chronology; the Asset ID encodes no usable time.'),
  groups: z.array(z.object({ key: z.string(), name: z.string() }))
    .describe('The Groups collaborating on this Asset. Pass a key to search_assets.groupKeys to narrow to that Group.'),
  owner: z.object({ key: z.string(), name: z.string() }).nullable()
    .describe('The recorded Owner, if any. Useful for telling candidates apart; search_assets cannot filter by it, so narrow on the returned results.'),
  identifiers: z.array(identifierSummarySchema)
    .describe('Every external identity Kannabi holds for this Asset. Zero identifiers is an ordinary state, not missing data.'),
  kannabiAllocatedGiai: z.string().nullable()
    .describe('The GIAI Kannabi itself issued for this Asset, taken from its issuance ledger, as a bare AI 8004 asset reference. Null means Kannabi issued none — including when the Asset stores a GIAI that merely begins with a managed company prefix.'),
  photoCount: z.number().int()
    .describe('How many photos Kannabi holds for this Asset. The images are not served over MCP.'),
});

const attributionSchema = z.object({
  key: z.string(), name: z.string(), status: z.enum(['active', 'deleted']),
}).describe('Who acted, as immutable provenance. "deleted" means the account is gone and only the name was kept. Never an indication of who may access the Asset.');

const allocationSchema = z.object({
  value: z.string()
    .describe('The issued GIAI as a bare AI 8004 asset reference, which is what resolve_external_identifier takes as assetReference.'),
  gcp: z.string().describe('The GS1 Company Prefix this value was issued from.'),
  sequence: z.number().int()
    .describe('The asset reference number the namespace counter produced. Unique within the namespace; gaps are excluded ranges, not missing issuances.'),
  allocatedAt: z.string().describe('When Kannabi issued the value.'),
  allocatedForAssetId: z.string()
    .describe('The Asset this issuance is permanently bound to. The binding survives detaching the identifier, and the value is never reissued elsewhere.'),
  allocatedBy: attributionSchema,
});

function detail(asset: Asset) {
  return {
    ...summarise(asset),
    reportedBy: asset.reportedBy,
    identifiers: asset.identifiers.map((identifier) => ({
      scheme: identifier.scheme,
      canonical: identifier.canonical,
      level: identifier.level,
      components: identifier.components,
      gs1PolicyVersion: identifier.policyVersion,
    })),
    allocation: asset.allocation,
    photos: asset.photos,
  };
}

const detailSchema = summarySchema.extend({
  reportedBy: attributionSchema.describe('Who reported this Asset to Kannabi. Immutable provenance, never an access grant.'),
  identifiers: z.array(identifierSummarySchema.extend({
    gs1PolicyVersion: z.string()
      .describe('The version of Kannabi\'s GS1 policy that accepted this value. Historical provenance; stored identifiers are never revalidated.'),
  })).describe('Every external identity Kannabi holds for this Asset.'),
  allocation: allocationSchema.nullable()
    .describe('Kannabi\'s own issuance record for this Asset, or null if Kannabi issued nothing for it. This, not the presence of a GIAI among identifiers, is what makes an identifier Kannabi-issued.'),
  photos: z.array(z.object({
    key: z.string(), contentType: z.string(), size: z.number(), createdAt: z.string().nullable(),
  })).describe('Photo records Kannabi holds. Their bytes are not served over MCP; the keys identify them within Kannabi.'),
});

const namespaceSchema = z.object({
  namespaceKey: z.string().describe('Pass this to list_giai_issuances. Match a namespace by its gcp field when a request names a company prefix.'),
  gcp: z.string().describe('The GS1 Company Prefix this namespace issues from.'),
  active: z.boolean()
    .describe('Whether new issuance is enabled. Configuration state only: a deactivated namespace keeps every value it already issued.'),
  group: z.object({ key: z.string(), name: z.string() })
    .describe('The one Kannabi Group that manages this prefix.'),
  nextSequence: z.number().int()
    .describe('The next asset reference number the counter would consider. NOT a count of issuances: it also advances past excluded ranges. Use list_giai_issuances.matching for how many Kannabi issued.'),
  excludedReferences: z.array(z.object({ from: z.number().int(), to: z.number().int() }))
    .describe('Reference numbers Kannabi must never issue because they were already in use elsewhere when the namespace was configured.'),
  configuredAt: z.string().describe('When a Group asserted this prefix. Kannabi cannot verify GS1 licensing.'),
});

function describeNamespace(namespace: GiaiNamespace) {
  return {
    namespaceKey: namespace.key,
    gcp: namespace.gcp,
    active: namespace.active,
    group: { key: namespace.group.key, name: namespace.group.name },
    // The next reference the counter would consider, not a count of issuances:
    // it also advances past excluded ranges. What Kannabi actually issued is
    // `list_giai_issuances`, and nothing else.
    nextSequence: namespace.nextSequence,
    excludedReferences: namespace.exclusions.map((range) => ({ from: range.from, to: range.to })),
    configuredAt: namespace.configuredAt,
  };
}

function describeIssuance(issuance: GiaiIssuance) {
  const { allocation, asset } = issuance;
  return {
    allocation,
    assetId: allocation.allocatedForAssetId,
    asset: asset ? summarise(asset) : null,
    // A Kannabi-issued GIAI stays bound to its Asset in the ledger even when
    // the identifier has been detached, so the two facts are reported apart.
    stillAttached: asset
      ? asset.identifiers.some((identifier) => identifier.scheme === 'giai'
        && identifier.components.assetReference === allocation.value)
      : null,
  };
}

/** A tool result carries both renderings of the same value: the structured one
 * for the client, and its JSON text for models that only read content. */
function result<T>(value: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value };
}

function failed(error: unknown) {
  if (error instanceof ValidationError || error instanceof DomainReferenceError) {
    return { content: [{ type: 'text' as const, text: error.message }], isError: true };
  }
  throw error;
}

/** Turn typed tool arguments into the query record the shared request parsers
 * accept, so the MCP surface reuses Kannabi's validation rather than restating
 * it. Absent arguments are omitted, which is what "unset" means to a parser. */
function queryRecord(entries: Record<string, string | string[] | number | undefined>) {
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
  version: '0.1.0',
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
export const instructions = `Kannabi is an Asset registry and an identity mediator: it records physical things and the different identities by which each one is known.

Kannabi owns these facts, and this server can answer them:
- the Asset itself: its name, when and by whom it was reported, its owner, the Groups that collaborate on it, and whether it is public;
- the native Kannabi Asset ID, which addresses an Asset inside Kannabi and carries no meaning in any other system;
- the external GS1 identifiers attached to an Asset (GTIN, SGTIN, GRAI, GIAI), at individual or class level;
- Groups, the unit that collaborates on Assets;
- the GS1 Company Prefix namespaces Kannabi Groups manage, and the ledger of GIAIs Kannabi itself issued from them.

Kannabi does not own these facts, and this server cannot answer them:
- where an Asset is now or where it has been;
- business-process or supply-chain events involving it, which an EPCIS repository owns;
- sensor readings, telemetry, or any other observation;
- an Asset's condition, availability, bookings, or maintenance history;
- anything about an identifier Kannabi was never told.
When a request needs one of these, report that Kannabi does not hold it instead of inferring it from what is here. Those facts belong to other systems, which may expose tools of their own.

Choosing a tool:
- an incomplete human description, such as "the inspection camera" -> search_assets;
- a complete GS1 identifier already in hand -> resolve_external_identifier;
- a native Kannabi Asset ID -> get_asset;
- list_groups and list_giai_namespaces supply the keys the other tools accept.
Every Asset a tool returns carries its assetId, which is the stable handle get_asset takes.

Two distinctions matter here and must not be collapsed:
- individual identity is not class identity. A class-level identifier such as a GTIN describes a kind of thing, so several Assets are a correct answer rather than an ambiguity. An individual-level identifier resolves to at most one.
- storing an identifier is not issuing it. Kannabi claims to have allocated a value only where its issuance ledger records it. An Asset whose stored GIAI merely begins with a managed company prefix was not issued by Kannabi, and list_giai_issuances is the only evidence of issuance.

Every tool here is read-only. This server reads the whole instance, so results are not filtered by any Kannabi User's permissions and must not be presented as one person's view.`;

export function createMcpServer(store: IdentityStore): McpServer {
  const server = new McpServer(serverInfo, { capabilities: { tools: {} }, instructions });
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

  server.registerTool('search_assets', {
    title: 'Search Assets',
    description: [
      'Find Kannabi Assets by name fragment and structured facts, for an incomplete description',
      'such as "the inspection camera". Matching is a plain case-insensitive substring of the',
      'Asset name: it never ranks, guesses or infers. Use this to narrow a candidate set, then',
      'inspect a candidate with get_asset using the assetId returned here.',
      'Only the arguments below narrow the query. Owner and reporter are returned on each result to',
      'tell candidates apart, but cannot be searched on; narrow on the results instead.',
      'To resolve a complete GS1 identifier you already hold, use resolve_external_identifier instead.',
      'Results are totally ordered and paged with an opaque cursor bound to this query\'s filters',
      'and ordering: reuse it only with the same query, groupKeys, schemes, identified, reportedFrom,',
      'reportedTo, sort and direction. Only limit may differ between pages.',
    ].join(' '),
    inputSchema: z.object({
      query: z.string().max(200).optional()
        .describe('Case-insensitive substring of the Asset name. Omit to browse everything.'),
      groupKeys: z.array(z.string()).optional()
        .describe('Restrict to Assets a listed Group collaborates on. Keys come from list_groups.'),
      schemes: z.array(z.enum(identifierSchemes as readonly [string, ...string[]])).optional()
        .describe('Restrict to Assets carrying an identifier in one of these GS1 schemes.'),
      identified: z.enum(['any', 'none']).optional()
        .describe('"any": Assets with at least one external identifier. "none": Assets with none.'),
      reportedFrom: z.string().optional()
        .describe('Lower bound on reportedAt, as an ISO date or instant.'),
      reportedTo: z.string().optional()
        .describe('Upper bound on reportedAt. A plain date covers that whole day; an instant is exact.'),
      sort: z.enum(assetSorts).optional().describe('Default "name". "reportedAt" is the Asset chronology.'),
      direction: z.enum(assetDirections).optional().describe('Default "asc".'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size, default 30.'),
      cursor: z.string().optional().describe('nextCursor from the previous page of this same query.'),
    }),
    outputSchema: z.object({
      assets: z.array(summarySchema).describe('This page of candidates, in the requested order.'),
      matching: z.number().int()
        .describe('Assets matching the whole query, not just this page. Zero means nothing matched what was asked.'),
      total: z.number().int()
        .describe('Assets this server holds in total, ignoring the query. With matching 0 it separates "nothing matched" from "Kannabi holds nothing".'),
      nextCursor: z.string().nullable()
        .describe('Pass back as cursor for the next page, or null when this page is the last. Opaque: never parse or construct one.'),
    }),
    annotations: readOnly,
  }, async (input) => {
    try {
      const request = assetPageRequest(queryRecord({
        q: input.query, group: input.groupKeys, scheme: input.schemes, identified: input.identified,
        reportedFrom: input.reportedFrom, reportedTo: input.reportedTo,
        sort: input.sort, dir: input.direction, limit: input.limit, cursor: input.cursor,
      }));
      const page = await store.findAssets(systemAudience, request);
      return result({
        assets: page.assets.map(summarise), matching: page.matching,
        total: page.total, nextCursor: page.nextCursor,
      });
    } catch (error) { return failed(error); }
  });

  server.registerTool('resolve_external_identifier', {
    title: 'Resolve an external identifier',
    description: [
      'Resolve one complete GS1 identifier to the Assets that carry it. Exact and deterministic:',
      'the value is validated by Kannabi\'s GS1 boundary and compared against the stored canonical',
      'form. Nothing is matched by substring or prefix.',
      'An individual-level identifier (SGTIN, GIAI, serialised GRAI) resolves to at most one Asset.',
      'A class-level identifier (GTIN, unserialised GRAI) describes a class and may legitimately',
      'resolve to many, which are paged.',
      'An empty result means no Asset carries the identifier — it never means the value is invalid,',
      'which is reported as an error instead.',
      'This tool takes external identities only; a native Kannabi Asset ID goes to get_asset.',
      'Each result already carries the Asset\'s name, Groups and identifiers; call get_asset with its',
      'assetId only when the full record is needed.',
    ].join(' '),
    inputSchema: z.object({
      scheme: z.enum(identifierSchemes as readonly [string, ...string[]])
        .describe('gtin and unserialised grai are class-level; sgtin, giai and serialised grai are individual.'),
      gtin: z.string().optional().describe('For gtin and sgtin: the GTIN/JAN, up to 14 digits.'),
      serial: z.string().optional().describe('For sgtin (required) and grai (optional).'),
      assetType: z.string().optional()
        .describe('For grai: the 13-digit asset type including its check digit, without the AI 8003 zero filler.'),
      assetReference: z.string().optional()
        .describe('For giai: the complete AI 8004 value including the company prefix.'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size for a class identifier, default 30.'),
      cursor: z.string().optional().describe('nextCursor from the previous page for this same identifier.'),
    }),
    outputSchema: z.object({
      identity: z.object({
        scheme: z.enum(identifierSchemes as readonly [string, ...string[]]),
        canonical: z.string().describe('The GS1 element-string form the input resolved to.'),
        level: z.enum(['individual', 'class']),
        levelMeaning: z.string()
          .describe('What this level means for the result count, so several Assets read as an answer rather than an ambiguity.'),
      }).describe('The identity as Kannabi understood it, echoed before any Asset was read, so it discloses nothing about what exists.'),
      assets: z.array(summarySchema).describe('The Assets carrying this identity. Empty means no Asset carries it.'),
      matching: z.number().int().describe('Assets carrying this identity in total, not just this page.'),
      nextCursor: z.string().nullable()
        .describe('Pass back as cursor for the next page of a class identity, or null when this page is the last.'),
    }),
    annotations: readOnly,
  }, async (input) => {
    try {
      const { limit, cursor, ...identifier } = input;
      const request = assetLookupQuery({
        ...Object.fromEntries(Object.entries(identifier).filter(([, value]) => value !== undefined)),
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      const lookup = await store.lookupAssets(systemAudience, request);
      if (lookup.identity.kind !== 'identifier') throw new ValidationError('An external identifier is required');
      const { canonical, scheme, level } = lookup.identity;
      return result({
        identity: { scheme, canonical, level, levelMeaning: identifierLevels[level] },
        assets: lookup.assets.map(summarise),
        matching: lookup.matching,
        nextCursor: lookup.nextCursor,
      });
    } catch (error) { return failed(error); }
  });

  server.registerTool('get_asset', {
    title: 'Inspect an Asset',
    description: [
      'Return everything Kannabi knows about one Asset, addressed by its native Kannabi Asset ID.',
      'The Asset ID is Kannabi\'s own identity anchor and the stable handle returned by every other',
      'tool here; it is not a GS1 identifier and has no meaning in any other system.',
      'Its embedded UUIDv7 timestamp carries no domain meaning — reportedAt is the chronology.',
      'Returns found: false when no such Asset exists.',
    ].join(' '),
    inputSchema: z.object({
      assetId: z.string().describe('A native Kannabi Asset ID: a lowercase UUIDv7.'),
    }),
    outputSchema: z.object({
      found: z.boolean()
        .describe('False when Kannabi holds no Asset with that ID. A well-formed ID that is not found is an answer, not an error.'),
      asset: detailSchema.nullable(),
    }),
    annotations: readOnly,
  }, async ({ assetId }) => {
    try {
      if (!isAssetId(assetId)) {
        throw new ValidationError('A native Kannabi Asset ID is required: the lowercase UUIDv7 that search_assets '
          + 'and resolve_external_identifier return as assetId. To find an Asset from a description, use search_assets; '
          + 'from a GS1 identifier, use resolve_external_identifier.');
      }
      const asset = await store.getAsset(assetId, systemAudience);
      return result({ found: asset !== null, asset: asset ? detail(asset) : null });
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
  }, async () => {
    const groups = await store.listGroups(systemAudience);
    return result({ groups: groups.map((group) => ({ key: group.key, name: group.name })) });
  });

  server.registerTool('list_giai_namespaces', {
    title: 'List managed GIAI namespaces',
    description: [
      'List the GS1 Company Prefix namespaces a Kannabi Group has configured for issuing GIAIs.',
      'A namespace is the only place Kannabi claims allocation authority, and each belongs to one Group.',
      'Use a namespaceKey with list_giai_issuances to see what Kannabi actually issued from it.',
      'Kannabi cannot verify GS1 licensing: a configured prefix is an assertion by an authorized member.',
    ].join(' '),
    outputSchema: z.object({
      namespaces: z.array(namespaceSchema)
        .describe('Every managed prefix in this instance. An empty list means no Group has configured one, so Kannabi has issued nothing at all.'),
    }),
    annotations: readOnly,
  }, async () => {
    const namespaces = await store.listGiaiNamespaces(systemAudience);
    return result({ namespaces: namespaces.map(describeNamespace) });
  });

  server.registerTool('list_giai_issuances', {
    title: 'List GIAI issuances from a namespace',
    description: [
      'Read Kannabi\'s issuance ledger for one managed namespace: the GIAIs Kannabi itself allocated,',
      'in issued order, each permanently bound to the Asset it was issued for.',
      'This is the only evidence of Kannabi allocation provenance. An Asset whose stored GIAI merely',
      'begins with the same company prefix was not allocated by Kannabi and does not appear here:',
      'storing an identifier is not issuing it.',
      'stillAttached reports whether the issued value is still attached to that Asset; a detached',
      'issuance stays in the ledger and its value is never reissued.',
    ].join(' '),
    inputSchema: z.object({
      namespaceKey: z.string()
        .describe('namespaceKey from list_giai_namespaces. When a request names a company prefix, find the namespace whose gcp matches and use its namespaceKey; the prefix itself is not a key.'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size, default 30.'),
      cursor: z.string().optional().describe('nextCursor from the previous page for this same namespace.'),
    }),
    outputSchema: z.object({
      namespace: namespaceSchema.describe('The namespace these issuances came from.'),
      issuances: z.array(z.object({
        allocation: allocationSchema,
        assetId: z.string().describe('The Asset this value was issued for. Pass it to get_asset.'),
        asset: summarySchema.nullable().describe('The Asset itself, when this server can read it.'),
        stillAttached: z.boolean().nullable()
          .describe('Whether the issued value is still attached to that Asset. False means it was detached: the issuance stands and the value is never reissued.'),
      })).describe('One page of issuances, in issued order. The ledger is the only record of what Kannabi allocated from this namespace; matching gives its full size, and nextCursor the rest.'),
      matching: z.number().int()
        .describe('How many GIAIs Kannabi issued from this namespace in total. Zero means it has issued none.'),
      nextCursor: z.string().nullable()
        .describe('Pass back as cursor for the next page, or null when this page is the last.'),
    }),
    annotations: readOnly,
  }, async (input) => {
    try {
      const page = await store.giaiIssuances(systemAudience, giaiLedgerQuery(queryRecord({
        namespaceKey: input.namespaceKey, limit: input.limit, cursor: input.cursor,
      })));
      return result({
        namespace: describeNamespace(page.namespace),
        issuances: page.issuances.map(describeIssuance),
        matching: page.matching,
        nextCursor: page.nextCursor,
      });
    } catch (error) { return failed(error); }
  });

  return server;
}
