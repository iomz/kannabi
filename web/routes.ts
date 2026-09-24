import { index, route, type RouteConfig } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('signin', 'routes/signin.tsx'),
  route('signup', 'routes/signup.tsx'),
  route('forgot-password', 'routes/forgot-password.tsx'),
  route('reset-password', 'routes/reset-password.tsx'),
  route('assets/report', 'routes/report.tsx'),
  route('asset/:id', 'routes/asset.tsx'),
  route('lookup', 'routes/lookup.tsx'),
  route('groups', 'routes/groups.tsx'),
  route('profile', 'routes/profile.tsx'),
  route('users', 'routes/users.tsx'),
  route('users/:key', 'routes/user.tsx'),
  route('settings', 'routes/settings-layout.tsx', [
    index('routes/settings-profile.tsx'),
    route('appearance', 'routes/settings-appearance.tsx'),
    route('security', 'routes/settings-security.tsx'),
  ]),
  route('admin/members', 'routes/members.tsx'),
  route('admin/settings', 'routes/settings.tsx'),
] satisfies RouteConfig;
