import * as z from 'zod/v4';
import { assetSummary, summaryOmits } from '../../../server/asset-representation.js';
import { assetSummarySchema, attributionSchema, omittedSchema, queryRecord } from '../../../server/mcp-tools.js';
import type { McpContribution } from '../../../server/plugin.js';
import { classKeySchemes, issuanceSchemes } from '../toolkit/gs1.js';
import { gs1LedgerQuery } from './ledger.js';
import {
  namespaceCounters, type Gs1ClassKeyAllocation, type Gs1LedgerEntry, type Gs1Namespace, type Gs1Store,
} from './store.js';

/** The GS1 plugin's read-only MCP tools.
 *
 * They answer what this plugin owns the answer to: which GS1 Company Prefix
 * namespaces a Group manages, which class keys each can serialise under, and
 * which values Kannabi itself issued. Each calls the same operation the HTTP
 * routes call, under the audience core resolved for the request.
 */

const issuanceSchema = z.object({
  key: z.string().describe('Kannabi\'s handle for this ledger row.'),
  scheme: z.enum(issuanceSchemes as unknown as readonly [string, ...string[]])
    .describe('Which GS1 key Kannabi issued. A GIAI comes straight from the company prefix; a serialised GRAI and an SGTIN are serials under a managed class key.'),
  canonical: z.string()
    .describe('The issued identifier in GS1 element-string form, which is what get_asset and resolve_external_identifier report for the same value.'),
  gcp: z.string().describe('The GS1 Company Prefix this value was issued from.'),
  sequence: z.number().int()
    .describe('The number the counter produced. Unique only within the counter that produced it — the namespace for a GIAI, the class key for a serial — so it orders issuances within one counter and nowhere else. Gaps are excluded ranges, not missing issuances.'),
  classKeyCanonical: z.string().nullable()
    .describe('The managed class key this was serialised under, for a serialised GRAI or an SGTIN. Null for a GIAI, which has no class level.'),
  allocatedAt: z.string().describe('When Kannabi issued the value.'),
  allocatedForAssetId: z.string()
    .describe('The Asset this issuance is permanently bound to. The binding survives detaching the identifier, and the value is never reissued elsewhere.'),
  allocatedBy: attributionSchema,
});

const classKeySchema = z.object({
  classKeyKey: z.string().describe('Kannabi\'s handle for this managed class key.'),
  scheme: z.enum(classKeySchemes as unknown as readonly [string, ...string[]])
    .describe('gtin for a trade item, grai for a returnable asset type.'),
  canonical: z.string().describe('The class key in GS1 element-string form.'),
  provenance: z.enum(['allocated', 'adopted'])
    .describe('allocated means Kannabi produced this reference from the namespace counter. adopted means the Group asserted a key it had already allocated elsewhere so Kannabi could issue serials under it. Kannabi claims to have allocated only the first.'),
  active: z.boolean()
    .describe('Whether new serials may be issued under it. Configuration state only: a deactivated class key keeps every serial it already issued.'),
  sequence: z.number().int().nullable()
    .describe('The counter position that produced it, or null when adopted.'),
  nextSerial: z.number().int()
    .describe('The next serial number the counter would consider under this class key. Not a count of issuances: it also advances past excluded ranges.'),
  excludedSerials: z.array(z.object({ from: z.number().int(), to: z.number().int() }))
    .describe('Decimal serials Kannabi must never issue under this class key, because they were already in use elsewhere when it was brought into the namespace. Kannabi issues decimal serials; serials in another form that exist elsewhere for the same class key cannot be expressed here, and serial non-duplication for a GTIN remains the GTIN allocator\'s responsibility as a party.'),
  assertedAt: z.string().describe('When this class key was brought into the namespace.'),
  assertedBy: attributionSchema,
});

function describeClassKey(classKey: Gs1ClassKeyAllocation) {
  return {
    classKeyKey: classKey.key,
    scheme: classKey.scheme,
    canonical: classKey.canonical,
    provenance: classKey.provenance,
    active: classKey.active,
    sequence: classKey.sequence,
    nextSerial: classKey.serial.nextSequence,
    excludedSerials: classKey.serial.exclusions.map((range) => ({ from: range.from, to: range.to })),
    assertedAt: classKey.assertedAt,
    assertedBy: classKey.assertedBy,
  };
}

const counterSchema = z.object({
  nextSequence: z.number().int()
    .describe('The next number this counter would consider. NOT a count of issuances: it also advances past excluded ranges.'),
  excludedReferences: z.array(z.object({ from: z.number().int(), to: z.number().int() }))
    .describe('Numbers Kannabi must never issue from this counter, because they were already in use elsewhere when the namespace was configured.'),
});

const namespaceSchema = z.object({
  namespaceKey: z.string().describe('Pass this to list_gs1_issuances and list_managed_class_keys. Match a namespace by its gcp field when a request names a company prefix.'),
  gcp: z.string().describe('The GS1 Company Prefix this namespace issues from.'),
  active: z.boolean()
    .describe('Whether new issuance is enabled. Configuration state only: a deactivated namespace keeps every value it already issued.'),
  group: z.object({ key: z.string(), name: z.string() })
    .describe('The one Kannabi Group that manages this prefix.'),
  counters: z.object(Object.fromEntries(namespaceCounters.map((counter) => [counter, counterSchema])))
    .describe('One independent counter per key type: giai for AI 8004 asset references, graiType for AI 8003 asset types, gtinItem for GTIN item references. They never share numbers, because a GTIN and a GRAI made of the same digits are different keys. Use list_gs1_issuances.matching for how many values Kannabi issued.'),
  classKeyIssuable: z.boolean()
    .describe('Whether this prefix leaves room for a twelve-digit class reference. False means it can still issue GIAIs but cannot allocate a GTIN or a GRAI asset type — a reduced capability, not an invalid namespace.'),
  unissuableReason: z.string().nullable()
    .describe('Why this namespace can issue nothing further, or null when it can. Set only for a prefix configured under an earlier, looser policy. Its already-issued values and its ledger stay valid and readable; only new issuance is refused.'),
  gtinFormat: z.enum(['GTIN-12', 'GTIN-13'])
    .describe('Which GTIN format this namespace\'s own allocations take, derived from the prefix. Presentation for whoever prints the symbol; the stored value is the same fourteen digits either way.'),
  configuredAt: z.string().describe('When a Group asserted this prefix. Kannabi cannot verify GS1 licensing.'),
});

function describeNamespace(namespace: Gs1Namespace) {
  return {
    namespaceKey: namespace.key,
    gcp: namespace.gcp,
    active: namespace.active,
    group: { key: namespace.group.key, name: namespace.group.name },
    // The next number each counter would consider, not a count of issuances:
    // they also advance past excluded ranges. What Kannabi actually issued is
    // `list_gs1_issuances`, and nothing else.
    counters: Object.fromEntries(namespaceCounters.map((counter) => [counter, {
      nextSequence: namespace.counters[counter].nextSequence,
      excludedReferences: namespace.counters[counter].exclusions
        .map((range) => ({ from: range.from, to: range.to })),
    }])),
    classKeyIssuable: namespace.classKeyIssuable,
    unissuableReason: namespace.unissuableReason,
    gtinFormat: namespace.gtinFormat,
    configuredAt: namespace.configuredAt,
  };
}

function describeEntry(entry: Gs1LedgerEntry) {
  const { issuance, asset } = entry;
  return {
    issuance,
    assetId: issuance.allocatedForAssetId,
    asset: asset ? assetSummary(asset) : null,
    // An issued value stays bound to its Asset in the ledger even when the
    // identifier has been detached, so the two facts are reported apart. The
    // comparison is on the canonical form, which is what makes it one rule for
    // every scheme rather than a per-scheme component match.
    stillAttached: asset
      ? asset.identifiers.some((identifier) => identifier.canonical === issuance.canonical)
      : null,
  };
}


const instructions = `GS1 (plugin "gs1"): Kannabi records GS1 identifiers (gtin, sgtin, grai, giai) and can issue GIAIs, serialised GRAIs and SGTINs from a GS1 Company Prefix namespace a Group manages. A class-level identifier such as a GTIN may be carried by several Assets, which is an answer rather than an ambiguity; an individual-level one resolves to at most one. Storing an identifier is not issuing it: only extensions.gs1.issued on an Asset and list_gs1_issuances show what Kannabi issued, and a managed GTIN carries no product data. An identifier's address is a GS1 Digital Link path Kannabi dereferences; Kannabi is not a GS1-Conformant Resolver and emits no canonical GS1 Digital Link URI. list_gs1_namespaces supplies the namespaceKey the other GS1 tools take. resolve_external_identifier fields: gtin (for gtin and sgtin, up to 14 digits), serial (sgtin required, grai optional), assetType (grai: 13 digits including its check digit, without the AI 8003 zero filler), assetReference (giai: the complete AI 8004 value including the company prefix).`;

export function gs1Mcp(gs1: Gs1Store): McpContribution {
  return Object.freeze({
    instructions,
    tools: [{
      name: 'list_gs1_namespaces',
      title: 'List managed GS1 namespaces',
      description: [
        'List the GS1 Company Prefix namespaces a Kannabi Group has configured for issuing GS1 keys.',
        'A namespace is the only place Kannabi claims allocation authority, and each belongs to one Group.',
        'One prefix issues GIAIs directly, and issues GRAI asset types and GTINs as class keys that',
        'serialised GRAIs and SGTINs are then issued under.',
        'Use a namespaceKey with list_gs1_issuances to see what Kannabi actually issued from it,',
        'and with list_managed_class_keys to see what it can issue serials under.',
        'Kannabi cannot verify GS1 licensing: a configured prefix is an assertion by an authorized member.',
      ].join(' '),
      outputSchema: z.object({
        namespaces: z.array(namespaceSchema)
          .describe('Every managed prefix in this instance. An empty list means no Group has configured one, so Kannabi has issued nothing at all.'),
      }),
      handler: async (_input, audience) =>
        ({ namespaces: (await gs1.listGs1Namespaces(audience)).map(describeNamespace) }),
    }, {
      name: 'list_managed_class_keys',
      title: 'List managed class keys in a namespace',
      description: [
        'List the class-level keys a namespace manages: the GTINs and GRAI asset types under which',
        'Kannabi may issue SGTIN and serialised GRAI serials.',
        'A class key is here only because a Group brought it into a prefix it manages, either by having',
        'Kannabi allocate the reference or by asserting one it had already allocated elsewhere;',
        'provenance says which. A GTIN merely recorded on an Asset is not a managed class key and',
        'cannot be serialised.',
        'These are allocation records and carry no product data: Kannabi holds no name, description or',
        'other trade-item detail for them, and is not a product catalogue.',
      ].join(' '),
      inputSchema: z.object({
        namespaceKey: z.string()
          .describe('namespaceKey from list_gs1_namespaces. When a request names a company prefix, find the namespace whose gcp matches; the prefix itself is not a key.'),
        scheme: z.enum(classKeySchemes as unknown as readonly [string, ...string[]]).optional()
          .describe('Narrow to gtin or grai. Omit for both.'),
      }),
      outputSchema: z.object({
        classKeys: z.array(classKeySchema)
          .describe('Every class key this namespace manages. An empty list means Kannabi can issue GIAIs from this prefix but has no class key to issue serials under.'),
      }),
      handler: async (input, audience) => ({
        classKeys: (await gs1.listClassKeys(audience, input.namespaceKey as string,
          input.scheme as 'gtin' | 'grai' | undefined)).map(describeClassKey),
      }),
    }, {
      name: 'list_gs1_issuances',
      title: 'List GS1 key issuances from a namespace',
      description: [
        'Read Kannabi\'s issuance ledger for one managed namespace: the GIAIs, serialised GRAIs and',
        'SGTINs Kannabi itself allocated, each permanently bound to the Asset it was issued for.',
        'This is the only evidence of Kannabi allocation provenance. An Asset whose stored identifier',
        'merely begins with the same company prefix was not allocated by Kannabi and does not appear',
        'here: storing an identifier is not issuing it.',
        'stillAttached reports whether the issued value is still attached to that Asset; a detached',
        'issuance stays in the ledger and its value is never reissued.',
        'Ordered by canonical form, because a sequence is unique only within the counter that produced',
        'it and an Asset\'s issuances can come from several.',
      ].join(' '),
      inputSchema: z.object({
        namespaceKey: z.string()
          .describe('namespaceKey from list_gs1_namespaces. When a request names a company prefix, find the namespace whose gcp matches and use its namespaceKey; the prefix itself is not a key.'),
        scheme: z.enum(issuanceSchemes as unknown as readonly [string, ...string[]]).optional()
          .describe('Narrow to one issued scheme: giai, grai or sgtin. Omit for all three.'),
        limit: z.number().int().min(1).max(100).optional().describe('Page size, default 30.'),
        cursor: z.string().optional()
          .describe('nextCursor from the previous page for this same namespace and scheme filter. A cursor does not carry across a change of filter.'),
      }),
      outputSchema: z.object({
        namespace: namespaceSchema.describe('The namespace these issuances came from.'),
        omitted: omittedSchema,
        entries: z.array(z.object({
          issuance: issuanceSchema,
          assetId: z.string().describe('The Asset this value was issued for. Pass it to get_asset.'),
          asset: assetSummarySchema.nullable().describe('The Asset itself, when this server can read it.'),
          stillAttached: z.boolean().nullable()
            .describe('Whether the issued value is still attached to that Asset. False means it was detached: the issuance stands and the value is never reissued.'),
        })).describe('One page of issuances. The ledger is the only record of what Kannabi allocated from this namespace; matching gives its full size, and nextCursor the rest.'),
        matching: z.number().int()
          .describe('How many values Kannabi issued from this namespace under the current scheme filter. Zero means it has issued none.'),
        nextCursor: z.string().nullable()
          .describe('Pass back as cursor for the next page, or null when this page is the last.'),
      }),
      handler: async (input, audience) => {
        const page = await gs1.gs1Issuances(audience, gs1LedgerQuery(queryRecord({
          namespaceKey: input.namespaceKey as string, scheme: input.scheme as string | undefined,
          limit: input.limit as number | undefined, cursor: input.cursor as string | undefined,
        })));
        return {
          namespace: describeNamespace(page.namespace),
          omitted: summaryOmits,
          entries: page.entries.map(describeEntry),
          matching: page.matching,
          nextCursor: page.nextCursor,
        };
      },
    }],
  });
}
