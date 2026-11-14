import { hc } from 'hono/client';
import type { Gs1Api } from '../adapter/http.js';

/** The GS1 plugin's routes, typed by the plugin itself. Core's client knows
 * nothing of them: they exist only in a Kannabi built with this plugin. */
export const gs1Api = hc<Gs1Api>('/api/gs1');
