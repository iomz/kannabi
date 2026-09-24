import assert from 'node:assert/strict';
import { test } from 'node:test';
import routes from '../web/routes.js';

type Node = { file: string; path?: string; index?: boolean; children?: Node[] };
const tree = routes as unknown as Node[];
const at = (path: string) => tree.find((node) => node.path === path);

test('User settings are separated by concern rather than one account page', () => {
  const settings = at('settings');
  assert.ok(settings, 'a settings area exists');
  assert.equal(settings.file, 'routes/settings-layout.tsx');
  // Profile is the landing section, so /settings resolves without a redirect.
  assert.deepEqual((settings.children ?? []).map((child) => [child.path ?? null, child.index ?? false]),
    [[null, true], ['appearance', false], ['security', false]]);
  // Credentials live under Security beside the password, not in Profile.
  assert.equal(settings.children?.[2].file, 'routes/settings-security.tsx');

  // Instance administration stays its own destination; the two never merge.
  assert.ok(at('admin/settings'), 'instance settings are unchanged');
  assert.notEqual(at('admin/settings')?.file, settings.file);

  // The former account page keeps working instead of becoming a dead link.
  assert.equal(at('profile')?.file, 'routes/profile.tsx');
});
