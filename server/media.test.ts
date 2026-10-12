import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings, defaultToastSeconds, displayDate, displayInstant, maxToastSeconds, minToastSeconds,
  validateSettingsChange } from './settings.js';
import { maxPhotoBytes, photoBytes } from './media.js';
import { orderPhotos } from './identity-store.js';

test('display timezone changes presentation without changing the absolute instant', () => {
  const instant = '2026-01-01T23:30:00.000Z';
  assert.match(displayInstant(instant, 'UTC'), /1 Jan 2026.*23:30/);
  assert.match(displayInstant(instant, 'Asia/Tokyo'), /2 Jan 2026.*08:30/);
  assert.match(displayInstant('2026-07-01T12:00:00Z', 'America/New_York'), /08:00/);
  assert.equal(instant, '2026-01-01T23:30:00.000Z');
  // A change names only what it changes: every field present is validated,
  // every field absent is left alone, so omission never resets anything.
  assert.deepEqual(validateSettingsChange({ themeId: 'raycast' }), { themeId: 'raycast' });
  assert.deepEqual(validateSettingsChange({}), {});
  assert.deepEqual(validateSettingsChange({ requirePhoto: true, displayTimezone: 'Asia/Tokyo' }),
    { requirePhoto: true, displayTimezone: 'Asia/Tokyo' });
  // Null is a value for the token-lifetime ceiling — no ceiling — and distinct
  // from leaving it alone; a ceiling is a whole number of days.
  assert.deepEqual(validateSettingsChange({ apiTokenMaxLifetimeDays: null }), { apiTokenMaxLifetimeDays: null });
  assert.deepEqual(validateSettingsChange({ apiTokenMaxLifetimeDays: 30 }), { apiTokenMaxLifetimeDays: 30 });
  for (const apiTokenMaxLifetimeDays of [0, -1, 1.5, '30', 36501]) {
    assert.throws(() => validateSettingsChange({ apiTokenMaxLifetimeDays }), String(apiTokenMaxLifetimeDays));
  }
  for (const name of ['requirePhoto', 'showAssetId', 'showIdentifierPolicyVersion', 'enforceGtinConsistency',
    'requireApproval']) {
    assert.deepEqual(validateSettingsChange({ [name]: false }), { [name]: false });
    for (const value of ['false', 0, null, 'yes']) {
      assert.throws(() => validateSettingsChange({ [name]: value }), `${name} ${String(value)}`);
    }
  }
  // The People directory is one of three named choices.
  for (const peopleDirectory of ['everyone', 'names', 'shared']) {
    assert.deepEqual(validateSettingsChange({ peopleDirectory }), { peopleDirectory });
  }
  for (const peopleDirectory of ['all', '', null, true]) {
    assert.throws(() => validateSettingsChange({ peopleDirectory }), String(peopleDirectory));
  }
  // How long a toast stays is deployment policy with a readable range.
  assert.deepEqual(validateSettingsChange({ toastSeconds: 12 }), { toastSeconds: 12 });
  for (const toastSeconds of [0, -1, 2.5, '5', null, minToastSeconds - 1, maxToastSeconds + 1]) {
    assert.throws(() => validateSettingsChange({ toastSeconds }), String(toastSeconds));
  }
  assert.throws(() => validateSettingsChange({ displayTimezone: 'not-a-zone' }));
  assert.throws(() => validateSettingsChange({ themeId: 'custom' }));
  assert.throws(() => validateSettingsChange({ requiredFields: [] }));
  // One place decides the defaults a new instance starts with.
  assert.deepEqual(defaultSettings, { requirePhoto: false, displayTimezone: 'UTC', themeId: 'default',
    apiTokenMaxLifetimeDays: null, toastSeconds: defaultToastSeconds, showAssetId: false,
    showIdentifierPolicyVersion: false, enforceGtinConsistency: true, peopleDirectory: 'everyone',
    requireApproval: true });
});

test('Kannabi renders date-only values in ISO order with slashes', () => {
  // The intended default for a future Admin/Settings preference. It presents
  // the date fields as written, so a filter bound shows the day that was chosen.
  assert.equal(displayDate('2026-09-19'), '2026/09/19');
  assert.equal(displayDate('2026-01-01T23:30:00.000Z'), '2026/01/01');
});

test('photo validation rejects empty, oversized, active content and mismatched MIME', async () => {
  await assert.rejects(photoBytes(new File([], 'empty.png', { type: 'image/png' })));
  await assert.rejects(photoBytes(new File([new Uint8Array(maxPhotoBytes + 1)], 'big.png', { type: 'image/png' })));
  await assert.rejects(photoBytes(new File(['<svg/>'], 'script.svg', { type: 'image/svg+xml' })));
  await assert.rejects(photoBytes(new File(['fake'], 'fake.png', { type: 'image/png' })));
});

test('photos order oldest to newest with deterministic ties and legacy entries first', () => {
  const photo = (key: string, createdAt: string | null) => ({ key, createdAt, contentType: 'image/png', size: 1 });
  assert.deepEqual(orderPhotos([
    photo('new', '2026-09-20T02:00:00.000Z'),
    photo('tie-b', '2026-09-20T01:00:00.000Z'),
    photo('legacy-b', null),
    photo('old', '2026-09-19T23:00:00.000Z'),
    photo('legacy-a', null),
    photo('tie-a', '2026-09-20T01:00:00.000Z'),
  ]).map(({ key }) => key), ['legacy-a', 'legacy-b', 'old', 'tie-a', 'tie-b', 'new']);
});
