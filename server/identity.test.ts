import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { requiredText, ValidationError } from './identity.js';

/** `requiredText` is the text contract most of the domain delegates to, so
 * the character class it refuses is pinned here exactly: C0 controls and DEL,
 * and nothing either side of them. */

const rejects = (value: unknown) =>
  assert.throws(() => requiredText(value, 'name'), ValidationError, JSON.stringify(value));
const accepts = (value: string, expected = value) =>
  assert.equal(requiredText(value, 'name'), expected, JSON.stringify(value));
const hex = (code: number) => 'U+' + code.toString(16).toUpperCase().padStart(4, '0');

test('every C0 control character and DEL is refused, even inside ordinary text', () => {
  for (let code = 0x00; code <= 0x1f; code += 1) {
    assert.throws(() => requiredText(`a${String.fromCharCode(code)}b`, 'name'), ValidationError, hex(code));
  }
  assert.throws(() => requiredText('a\x7Fb', 'name'), ValidationError, hex(0x7f));
});

test('the characters either side of the refused ranges are accepted', () => {
  // Space and '!' sit just above U+001F; '~' just below DEL, and U+0080 just
  // above it. C1 controls are not part of the contract.
  for (const value of ['a b', 'a!b', 'a~b', 'a\u0080b', 'a\u009Fb', 'a b']) accepts(value);
});

test('across the Basic Multilingual Plane, only those 33 code units are refused', () => {
  const refused: number[] = [];
  for (let code = 0; code <= 0xffff; code += 1) {
    try { requiredText(`a${String.fromCharCode(code)}b`, 'name'); } catch { refused.push(code); }
  }
  const expected = [...Array.from({ length: 0x20 }, (_, code) => code), 0x7f];
  assert.deepEqual(refused, expected);
});

test('ordinary values keep working and are trimmed', () => {
  accepts('Ada Lovelace');
  accepts('Jean-Luc O\'Brien, Jr.');
  accepts('東京 ラボ');
  accepts('Zoë Ólafsdóttir');
  accepts('Bench 005 · 😀');
  accepts('  padded  ', 'padded');
  accepts('x y');
});

test('blank, whitespace-only and non-string values are refused', () => {
  for (const value of ['', ' ', '　', ' ', 'x\n', '\tx', 42, null, undefined, {}]) rejects(value);
});

test('identity.ts holds no control bytes, so Git diffs it as text', () => {
  // A NUL byte makes Git classify a file as binary and print "Binary files
  // differ" in place of a patch. Only tab, line feed and carriage return are
  // ordinary text.
  const source = readFileSync(new URL('./identity.ts', import.meta.url));
  const offending = [...source.entries()]
    .filter(([, byte]) => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f)
    .map(([offset, byte]) => `${hex(byte)} at byte ${offset}`);
  assert.deepEqual(offending, []);
});
