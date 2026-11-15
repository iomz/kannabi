import { compose } from '../../server/plugin.js';

import { gs1Plugin } from './index.js';

/** Kannabi composed with the GS1 plugin and nothing else, for this plugin's
 * tests. They never read the deployment's own list: what they hold is what
 * Kannabi does with GS1 installed, whatever else a build has. */
export const definitions = [gs1Plugin];
export const composition = compose(definitions);
