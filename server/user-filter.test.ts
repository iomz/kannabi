import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UserAccount } from './identity-store.js';
import { filterUsers, nextUserSort, sortUsers } from '../web/user-filter.js';

const members: UserAccount[] = [
  { key: '1', name: 'Alex Demo', email: 'evaluator@demo.invalid', isAdmin: true, credentialState: 'established', createdAt: null, approvedAt: null },
  { key: '2', name: 'Morgan Demo', email: 'collaborator@demo.invalid', isAdmin: false, credentialState: 'pending', createdAt: null, approvedAt: null },
];

test('user search matches name and email without changing loaded order', () => {
  assert.deepEqual(filterUsers(members, ''), members);
  assert.deepEqual(filterUsers(members, '  alex  ').map((member) => member.key), ['1']);
  assert.deepEqual(filterUsers(members, 'COLLABORATOR').map((member) => member.key), ['2']);
  assert.deepEqual(filterUsers(members, 'missing'), []);
});

test('users sort by any column, either way, keeping ties and unknown join dates in place', () => {
  const users: UserAccount[] = [
    { key: 'b', name: 'Bea', email: 'z@example.test', isAdmin: false, credentialState: 'established',
      createdAt: '2026-10-02T00:00:00.000Z', approvedAt: '2026-10-02T00:00:00.000Z' },
    { key: 'a', name: 'Ann', email: 'y@example.test', isAdmin: true, credentialState: 'established',
      createdAt: null, approvedAt: '2026-10-01T00:00:00.000Z' },
    { key: 'c', name: 'Cy', email: 'x@example.test', isAdmin: false, credentialState: 'pending',
      createdAt: '2026-10-03T00:00:00.000Z', approvedAt: null },
    { key: 'd', name: 'Dee', email: 'w@example.test', isAdmin: false, credentialState: 'pending',
      createdAt: '2026-10-01T00:00:00.000Z', approvedAt: '2026-10-01T00:00:00.000Z' },
  ];
  const keys = (list: UserAccount[]) => list.map((user) => user.key).join('');
  assert.equal(keys(sortUsers(users, null)), 'bacd', 'no choice keeps the loaded order');
  assert.equal(keys(sortUsers(users, { column: 'name', direction: 'ascending' })), 'abcd');
  assert.equal(keys(sortUsers(users, { column: 'name', direction: 'descending' })), 'dcba');
  assert.equal(keys(sortUsers(users, { column: 'email', direction: 'ascending' })), 'dcab');
  assert.equal(keys(sortUsers(users, { column: 'joined', direction: 'ascending' })), 'dbca', 'unknown last');
  assert.equal(keys(sortUsers(users, { column: 'joined', direction: 'descending' })), 'cbda', 'unknown still last');
  assert.equal(keys(sortUsers(users, { column: 'access', direction: 'ascending' })), 'cdba', 'waiting, setup, established');
  assert.equal(keys(sortUsers(users, { column: 'role', direction: 'ascending' })), 'abcd', 'administrators first');
  assert.deepEqual(nextUserSort(null, 'name'), { column: 'name', direction: 'ascending' });
  assert.deepEqual(nextUserSort({ column: 'name', direction: 'ascending' }, 'name'), { column: 'name', direction: 'descending' });
  assert.deepEqual(nextUserSort({ column: 'name', direction: 'descending' }, 'name'), { column: 'name', direction: 'ascending' });
  assert.deepEqual(nextUserSort({ column: 'name', direction: 'descending' }, 'email'), { column: 'email', direction: 'ascending' });
});
