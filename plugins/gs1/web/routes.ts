import { route, type RouteConfigEntry } from '@react-router/dev/routes';

/** The GS1 plugin's routes, as paths from the web client's application
 * directory, which is where a route's module is resolved from. */
const here = '../plugins/gs1/web/';

/** GS1 Digital Link addresses. One module answers every supported form: it
 * reads the raw path rather than these parameters, so the shapes below only
 * have to reserve the right corner of the numeric path space. Adding a
 * qualifier combination later adds a line here and nothing else. */
export const gs1Routes: RouteConfigEntry[] = [
  route('01/:gtin/21/:serial', here + 'digital-link.tsx', { id: 'digital-link-sgtin' }),
  route('8003/:grai', here + 'digital-link.tsx', { id: 'digital-link-grai' }),
  route('8004/:giai', here + 'digital-link.tsx', { id: 'digital-link-giai' }),
];

/** A view of a Group's page: the prefixes it manages. */
export const gs1GroupRoutes: RouteConfigEntry[] = [
  route('prefixes', here + 'group-prefixes.tsx'),
];
