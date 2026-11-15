import { registerHooks } from 'node:module';

/** Core's tests run against the fixture plugin, whatever this checkout is
 * built with.
 *
 * The server and the web client learn their plugins from generated modules,
 * which follow the deployment's list. Loaded with `node --import`, this
 * answers those modules with the fixture plugin instead, so a core screen
 * under test, and a server process a test starts, is the same in a checkout
 * with GS1, with other plugins, or with none. It is for tests only and
 * changes nothing a build reads.
 */
const at = (path) => new URL(path, import.meta.url).href;
const fixtures = new Map([
  [at('./plugins.generated.ts'), at('./test-fixture.ts')],
  [at('../web/plugins.generated.ts'), at('./test-web-fixture.tsx')],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const fixture = fixtures.get(resolved.url);
    return fixture ? { ...resolved, url: fixture } : resolved;
  },
});
