import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayInstant, validateSettings } from './settings.js';
import { maxPhotoBytes, photoBytes } from './media.js';
import { orderPhotos } from './identity-store.js';

test('display timezone changes presentation without changing the absolute instant', () => {
  const instant = '2026-01-01T23:30:00.000Z';
  assert.match(displayInstant(instant, 'UTC'), /1 Jan 2026.*23:30/);
  assert.match(displayInstant(instant, 'Asia/Tokyo'), /2 Jan 2026.*08:30/);
  assert.match(displayInstant('2026-07-01T12:00:00Z', 'America/New_York'), /08:00/);
  assert.equal(instant, '2026-01-01T23:30:00.000Z');
  assert.deepEqual(validateSettings({ requirePhoto: false, displayTimezone: 'UTC', themeId: 'raycast' }),
    { requirePhoto: false, displayTimezone: 'UTC', themeId: 'raycast' });
  assert.throws(() => validateSettings({ requirePhoto: true, displayTimezone: 'not-a-zone', themeId: 'default' }));
  assert.throws(() => validateSettings({ requirePhoto: 'true', displayTimezone: 'UTC', themeId: 'default' }));
  assert.throws(() => validateSettings({ requirePhoto: false, displayTimezone: 'UTC', themeId: 'custom' }));
  assert.throws(() => validateSettings({ requirePhoto: false, displayTimezone: 'UTC', themeId: 'default', requiredFields: [] }));
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
