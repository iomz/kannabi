import { installed } from './plugin';
import { gs1Web } from '../plugins/gs1/web/index';

/** The one file that says which plugins the web client is built with.
 *
 * It mirrors `server/composition.ts`: a Kannabi with a different set of
 * plugins is this file and that one with different lines, plus the plugin
 * routes named in `web/routes.ts`, and one with none is `installed([])`.
 * Everything else in the web client asks this value and imports no plugin.
 */
export const web = installed([gs1Web]);
