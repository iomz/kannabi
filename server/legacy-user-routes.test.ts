import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientLoader as legacyUsers } from '../web/routes/legacy-users.js';
import { clientLoader as legacyAdminMembers } from '../web/routes/legacy-admin-members.js';

async function redirects(loader: () => unknown, destination: string) {
  await assert.rejects(async () => loader(), (error: unknown) => {
    assert.ok(error instanceof Response);
    assert.equal(error.status, 302);
    assert.equal(error.headers.get('Location'), destination);
    return true;
  });
}

test('legacy User directory route redirects to Workspace Members', async () => {
  await redirects(legacyUsers, '/members');
});

test('legacy administration Members route redirects to Users', async () => {
  await redirects(legacyAdminMembers, '/admin/users');
});
