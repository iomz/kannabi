import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isApplePlatform, searchKeyShortcuts, searchShortcutHint } from '../web/platform.js';

test('the search shortcut is written the way this machine writes it', () => {
  for (const hint of ['MacIntel', 'macOS', 'iPhone', 'iPad', 'MacARM']) {
    assert.equal(isApplePlatform(hint), true, hint);
  }
  for (const hint of ['Win32', 'Windows', 'Linux x86_64', 'Android', '']) {
    assert.equal(isApplePlatform(hint), false, hint);
  }
  assert.equal(searchShortcutHint(true), '⌘K');
  assert.equal(searchShortcutHint(false), 'Ctrl K');
  // Only the visible hint narrows. Both modifiers keep working, and assistive
  // technology is told so.
  assert.equal(searchKeyShortcuts, 'Meta+K Control+K');
});
