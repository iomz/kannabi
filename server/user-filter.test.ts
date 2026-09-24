import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UserAccount } from './identity-store.js';
import { filterUsers } from '../web/user-filter.js';

const members: UserAccount[] = [
  { key: '1', name: 'Alex Demo', email: 'evaluator@demo.invalid', isAdmin: true, credentialState: 'established', createdAt: null },
  { key: '2', name: 'Morgan Demo', email: 'collaborator@demo.invalid', isAdmin: false, credentialState: 'pending', createdAt: null },
];

test('user search matches name and email without changing loaded order', () => {
  assert.deepEqual(filterUsers(members, ''), members);
  assert.deepEqual(filterUsers(members, '  alex  ').map((member) => member.key), ['1']);
  assert.deepEqual(filterUsers(members, 'COLLABORATOR').map((member) => member.key), ['2']);
  assert.deepEqual(filterUsers(members, 'missing'), []);
});
