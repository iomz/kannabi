import { identifierSchemes } from './identifier.js';
import { gs1Rule, gs1Schemes } from './gs1-schemes.js';

/** What this build of Kannabi is composed of.
 *
 * The one place that names what is installed beside core. Core modules take
 * what they need as a value and never import from here, so a Kannabi with
 * nothing installed is this file with an empty list.
 */
export const schemes = identifierSchemes(gs1Schemes, [gs1Rule]);
