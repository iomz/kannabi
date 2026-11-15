import type { PluginDefinition } from '../../server/plugin.js';
import { gs1Addresses } from './adapter/addresses.js';
import { createGs1Api } from './adapter/http.js';
import { gs1Mcp } from './adapter/mcp.js';
import { gs1Rule, gs1Schemes } from './adapter/schemes.js';
import { issuedSection } from './adapter/section.js';
import { gs1Participant, gs1Persistence, Gs1Store } from './adapter/store.js';

/** GS1 for Kannabi, as a plugin.
 *
 * Two parts. `toolkit/` is GS1 itself as Kannabi needs it — syntax policy,
 * check digits, key composition, Digital Link encoding — and imports nothing
 * of Kannabi's. `adapter/` is what makes it a Kannabi capability: identifier
 * schemes, managed namespaces and class keys, issuance and its ledger, the
 * GTIN consistency policy, and the routes, tools and addresses that expose
 * them.
 *
 * A Kannabi built without this file in its composition has no GS1 at all: no
 * scheme, route, tool, setting or address, and nothing missing.
 */
export const gs1Plugin: PluginDefinition<Gs1Store> = Object.freeze({
  manifest: Object.freeze({
    id: 'gs1',
    name: 'GS1 identifiers',
    version: '0.1.0',
    contract: [1],
    requires: [],
    contributes: [
      'Identifier schemes: gtin, sgtin, grai, giai',
      'GS1 Company Prefix namespaces, managed class keys and key issuance',
      'GS1 Digital Link addresses for individual-level identifiers',
      'The GTIN consistency policy',
      'Asset representation section: extensions.gs1',
      'HTTP routes under /api/gs1/',
      'MCP tools: list_gs1_namespaces, list_managed_class_keys, list_gs1_issuances',
    ],
  }),
  schemes: gs1Schemes,
  rules: [gs1Rule],
  persistence: gs1Persistence,
  participant: gs1Participant,
  connect(core) {
    const gs1 = new Gs1Store(core);
    return Object.freeze({
      api: gs1,
      http: createGs1Api(gs1),
      addresses: gs1Addresses,
      mcp: gs1Mcp(gs1),
      assetSection: async (asset) => issuedSection(await gs1.issuancesFor(asset.id)),
    });
  },
});
