import { compose } from './plugin.js';
import { definitions } from './plugins.generated.js';

/** The plugins this Kannabi is built with, composed.
 *
 * Which plugins those are is the list `pnpm plugins:compose` reads, and
 * `plugins.generated.ts` is that list written out as ordinary imports. That
 * generated file is the one place the server names a plugin, and this is the
 * one file that imports it.
 *
 * Core modules never import this either: a store, an API and an MCP server
 * are each handed what was composed here. A Kannabi with a different set of
 * plugins is a different list, and one with none composes nothing. Order
 * matters only where one plugin calls another: a plugin comes after every
 * plugin it requires.
 */
export const composition = compose(definitions);
