import { installed } from './plugin';
import { plugins } from './plugins.generated';

/** The plugins the web client is built with.
 *
 * It mirrors `server/composition.ts`: `plugins.generated.ts` and
 * `routes.generated.ts` are the list `pnpm plugins:compose` reads, written out
 * as ordinary imports, and they are the only files in the web client that
 * name a plugin. Everything else asks this value and imports no plugin.
 */
export const web = installed(plugins);
