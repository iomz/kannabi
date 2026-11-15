import { compose } from './plugin.js';
import { gs1Plugin } from '../plugins/gs1/index.js';

/** The one file that says which plugins this Kannabi is built with.
 *
 * Core modules never import it: a store, an API and an MCP server are each
 * handed what was composed here. A Kannabi with a different set of plugins is
 * this file with different lines, and one with none is `compose([])`. Order
 * matters only where one plugin calls another: a plugin comes after every
 * plugin it requires.
 */
export const composition = compose([gs1Plugin]);
