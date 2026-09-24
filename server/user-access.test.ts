import assert from 'node:assert/strict';
import { test } from 'node:test';
import { userAccessLabel } from '../web/user-access.js';

test('user access labels distinguish pending setup from established passwords', () => {
  assert.equal(userAccessLabel('pending'), 'Setup pending');
  assert.equal(userAccessLabel('established'), 'Password established');
});
