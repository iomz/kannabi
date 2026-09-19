import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anonymousShellHandle, isAnonymousShellHandle, isPublicShellHandle,
  publicShellHandle, usesAnonymousShell } from '../web/anonymous-shell.js';

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
