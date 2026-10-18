import { index, route, type RouteConfig } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('signin', 'routes/signin.tsx'),
  route('signup', 'routes/signup.tsx'),
  route('forgot-password', 'routes/forgot-password.tsx'),
  route('reset-password', 'routes/reset-password.tsx'),
  route('assets/report', 'routes/report.tsx'),
  route('asset/:id', 'routes/asset.tsx'),
  // GS1 Digital Link addresses. One module answers every supported form: it
  // reads the raw path rather than these parameters, so the shapes below only
  // have to reserve the right corner of the numeric path space. Adding a
  // qualifier combination later adds a line here and nothing else.
  route('01/:gtin/21/:serial', 'routes/digital-link.tsx', { id: 'digital-link-sgtin' }),
  route('8003/:grai', 'routes/digital-link.tsx', { id: 'digital-link-grai' }),
  route('8004/:giai', 'routes/digital-link.tsx', { id: 'digital-link-giai' }),
  route('lookup', 'routes/lookup.tsx'),
  route('help', 'routes/help.tsx'),
  route('groups', 'routes/groups.tsx'),
  // A Group's destination, by key. One page in addressable views, each with
  // its own loader. Every view is offered to everybody who can open the
  // Group; what each one shows is the server's decision on every request.
  route('groups/:key', 'routes/group.tsx', [
    index('routes/group-overview.tsx'),
    route('assets', 'routes/group-assets.tsx'),
    route('people', 'routes/group-people.tsx'),
    route('prefixes', 'routes/group-prefixes.tsx'),
  ]),
  route('profile', 'routes/profile.tsx'),
  route('people', 'routes/people.tsx'),
  route('users', 'routes/legacy-users.tsx'),
  route('users/:key', 'routes/user.tsx'),
  route('settings', 'routes/settings-layout.tsx', [
    index('routes/settings-profile.tsx'),
    route('appearance', 'routes/settings-appearance.tsx'),
    route('security', 'routes/settings-security.tsx'),
  ]),
  route('admin/users', 'routes/admin-users.tsx'),
  route('admin/members', 'routes/legacy-admin-members.tsx'),
  route('admin/settings', 'routes/settings.tsx'),
] satisfies RouteConfig;
