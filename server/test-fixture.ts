import { ValidationError } from './identity.js';
import type { Identifier, IdentifierScheme } from './identifier.js';
import { z } from 'zod/v4';
import { compose, type AddressResolver, type McpContribution, type PluginDefinition } from './plugin.js';

/** A plugin for core's own tests.
 *
 * Core is tested against this and never against a real plugin, so that its
 * tests say what Kannabi does with a plugin installed without depending on
 * any particular one, and still run in a checkout that has none. It is as
 * plain as a plugin can be: two schemes, one address form, nothing stored.
 *
 * A shelf tag identifies one Asset; a model describes many. Neither means
 * anything outside these tests.
 */

const policy = 'shelf-1';

function identifier(scheme: 'tag' | 'model', value: string, policyVersion: string): Identifier {
  return Object.freeze({
    scheme,
    canonical: `${scheme}:${value}`,
    components: Object.freeze<Record<string, string>>(scheme === 'tag' ? { code: value } : { series: value }),
    level: scheme === 'tag' ? 'individual' as const : 'class' as const,
    policyVersion,
  });
}

/** Identifies one Asset: `T-` and letters or digits. */
export const tagScheme: IdentifierScheme = Object.freeze({
  id: 'tag',
  fields: ['code'],
  accept(input: Record<string, unknown>): Identifier {
    if (typeof input.code !== 'string' || !/^T-[A-Za-z0-9-]+$/.test(input.code)) throw new ValidationError('A tag is T- and letters or digits');
    return identifier('tag', input.code, policy);
  },
  restore: (canonical: unknown, policyVersion: unknown) =>
    identifier('tag', String(canonical).slice('tag:'.length), String(policyVersion)),
  address: (value: Identifier) => `/tag/${value.components.code}`,
});

/** Describes many Assets: a lowercase word. */
export const modelScheme: IdentifierScheme = Object.freeze({
  id: 'model',
  fields: ['series'],
  accept(input: Record<string, unknown>): Identifier {
    if (typeof input.series !== 'string' || !/^[a-z][a-z0-9-]*$/.test(input.series)) throw new ValidationError('A model is a lowercase word');
    return identifier('model', input.series, policy);
  },
  restore: (canonical: unknown, policyVersion: unknown) =>
    identifier('model', String(canonical).slice('model:'.length), String(policyVersion)),
});

/** The tag an Asset carries, as the identifier a caller would have named. */
export const tag = (code: string): Identifier => tagScheme.accept({ code });
export const model = (series: string): Identifier => modelScheme.accept({ series });

const addresses: AddressResolver = Object.freeze({
  claim(rawPath: string) {
    const match = /^\/tag\/([^/]*)$/.exec(rawPath);
    if (!match) return null;
    if (!/^T-[A-Za-z0-9-]+$/.test(match[1])) return { kind: 'invalid' as const, message: 'A tag is T- and letters or digits' };
    return { kind: 'identifier' as const, identifier: tag(match[1]) };
  },
  surfaced(asset) {
    const carried = asset.identifiers.find((value) => value.scheme === 'tag');
    return carried ? `/tag/${carried.components.code}` : null;
  },
});

/** One tool, so that what core does with a plugin's tools is exercised: it is
 * listed beside core's, and its handler is given the audience core resolved. */
export const shelfMcp = (seen: (audience: unknown) => void = () => {}): McpContribution => Object.freeze({
  instructions: 'Shelf tags are labels on things; this server knows nothing else about a shelf.',
  tools: [Object.freeze({
    name: 'list_shelf_models',
    title: 'List shelf models',
    description: 'List the model names the shelf fixture knows. It knows none, so the list is always empty; the tool exists so that a plugin\'s tool is listed and called like any other.',
    outputSchema: z.object({ models: z.array(z.string()).describe('The model names the fixture knows. Always empty.') }),
    handler: async (_input: Record<string, unknown>, audience: unknown) => { seen(audience); return { models: [] }; },
  })],
});

export const shelfPlugin: PluginDefinition<null> = Object.freeze({
  manifest: Object.freeze({
    id: 'shelf',
    name: 'Shelf tags',
    version: '0.0.1',
    contract: [1],
    requires: [],
    contributes: ['Identifier schemes: tag, model', 'Addresses of the form /tag/<code>', 'MCP tool: list_shelf_models'],
  }),
  schemes: [tagScheme, modelScheme],
  connect: () => Object.freeze({ api: null, addresses, mcp: shelfMcp() }),
});

/** What the generated plugin list exports, for a process started under
 * `test-composition.mjs`. */
export const definitions: readonly PluginDefinition[] = [shelfPlugin];

/** Kannabi composed with the fixture plugin and nothing else. */
export const composition = compose(definitions);
