import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anonymousShellHandle, isAnonymousShellHandle, isPublicShellHandle,
  publicShellHandle, usesAnonymousShell, usesWorkspaceHeader } from '../web/anonymous-shell.js';

test('anonymous shell selection requires explicit route metadata', () => {
  assert.equal(isAnonymousShellHandle(anonymousShellHandle), true);
  assert.equal(isAnonymousShellHandle({ shell: 'authenticated' }), false);
  assert.equal(isAnonymousShellHandle(null), false);
  assert.equal(isAnonymousShellHandle('/signin'), false);
});

test('public shell selection requires explicit route metadata', () => {
  assert.equal(isPublicShellHandle(publicShellHandle), true);
  assert.equal(isPublicShellHandle(anonymousShellHandle), false);
  assert.equal(isPublicShellHandle({ shell: 'authenticated' }), false);
  assert.equal(isPublicShellHandle('/asset'), false);
  assert.equal(usesAnonymousShell([publicShellHandle], false), true);
  assert.equal(usesAnonymousShell([publicShellHandle], true), false);
  assert.equal(usesAnonymousShell([anonymousShellHandle], true), true);
});

test('the Asset-search header belongs to the workspace, not to management contexts', () => {
  for (const pathname of ['/', '/lookup', '/groups', '/asset/0199', '/assets/report']) {
    assert.equal(usesWorkspaceHeader(pathname), true, pathname);
  }
  for (const pathname of ['/settings', '/settings/appearance', '/settings/security',
    '/admin', '/admin/users', '/admin/settings']) {
    assert.equal(usesWorkspaceHeader(pathname), false, pathname);
  }
  // Prefix matching must not swallow unrelated destinations that merely start
  // with the same letters.
  for (const pathname of ['/settingsomething', '/administration', '/adminish']) {
    assert.equal(usesWorkspaceHeader(pathname), true, pathname);
  }
});
