import type { WebPlugin } from '../../../web/plugin';
import { gs1Web } from './index';

/** The web client's plugin list with GS1 and nothing else, for this plugin's
 * tests. `test-composition.mjs` answers the generated list with it. */
export const plugins: readonly WebPlugin[] = [gs1Web];
