import { registerHooks } from 'node:module';

/** This plugin's tests run with GS1 composed and nothing else.
 *
 * The server and the web client learn their plugins from generated modules,
 * which follow the deployment's list. Loaded with `node --import`, this
 * answers those modules with GS1 alone, so a screen under test and a server
 * process a test starts are the same whatever else a deployment installs. It
 * is the counterpart of core's `server/test-composition.mjs`, for tests only.
 */
const at = (path) => new URL(path, import.meta.url).href;
const alone = new Map([
  [at('../../server/plugins.generated.ts'), at('./testing.ts')],
  [at('../../web/plugins.generated.ts'), at('./web/testing.ts')],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const replacement = alone.get(resolved.url);
    return replacement ? { ...resolved, url: replacement } : resolved;
  },
});
