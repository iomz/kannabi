import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';

/** Application routes whose address sits under `/assets/`, the directory the
 * build writes its hashed bundles to. The prefix belongs to the build, so
 * everything else under it is a file request: a missing bundle answers 404 and
 * never the application document, which a browser would otherwise try to run
 * as a script. A route listed here is the exception, and is listed by its
 * exact path so that nothing else under the prefix changes meaning.
 *
 * `web/routes.ts` is where such a route is declared; a test holds the two
 * together. */
export const applicationRoutesUnderBundlePrefix: ReadonlySet<string> = new Set(['/assets/report']);

const isApplicationRoute = (c: Context) =>
  applicationRoutesUnderBundlePrefix.has(c.req.path.replace(/\/+$/, ''));

/** Serves the single-page build in `root`: bundles from `/assets/`, and the
 * application document for every other GET. `beforeDocument` runs between the
 * two, for addresses whose answer the static document cannot give. */
export function clientBuild(root: string, ...beforeDocument: MiddlewareHandler[]) {
  const app = new Hono();
  const bundles = serveStatic({ root });
  app.use('/assets/*', (c, next) => (isApplicationRoute(c) ? next() : bundles(c, next)));
  app.all('/assets/*', (c, next) => (isApplicationRoute(c) ? next() : c.notFound()));
  for (const middleware of beforeDocument) app.use('*', middleware);
  app.get('*', serveStatic({ root, path: 'index.html' }));
  return app;
}
