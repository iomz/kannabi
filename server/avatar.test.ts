import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { gravatarIdentifier } from './avatar.js';
import { gravatarUrl } from '../shared/avatar.js';
import { Avatar } from '../web/avatar.js';

test('the Gravatar identifier follows the documented normalisation', () => {
  // Trimmed, lowercased, SHA-256 — the current documented requirement, not the
  // MD5 the service used to take.
  const canonical = gravatarIdentifier('person@example.com');
  assert.match(canonical, /^[0-9a-f]{64}$/);
  for (const variant of ['  person@example.com ', 'Person@Example.COM', '\tPERSON@EXAMPLE.COM\n']) {
    assert.equal(gravatarIdentifier(variant), canonical, variant);
  }
  assert.notEqual(gravatarIdentifier('someone.else@example.com'), canonical);
});

test('a requested avatar asks for nothing generated and nothing above G', () => {
  // The URL shape is shared so the browser and the server cannot disagree
  // about what is requested; only the hashing needs a server runtime.
  const url = new URL(gravatarUrl('a'.repeat(64), 64));
  assert.equal(url.origin + url.pathname, 'https://gravatar.com/avatar/' + 'a'.repeat(64));
  // 404 rather than a generated stand-in: Kannabi already has an honest
  // fallback, and inventing a face for somebody is not it.
  assert.equal(url.searchParams.get('d'), '404');
  assert.equal(url.searchParams.get('r'), 'g');
  assert.equal(url.searchParams.get('s'), '64');
  // The address is never part of the URL.
  assert.doesNotMatch(url.href, /@/);
});

test('an avatar makes no remote request for somebody who did not ask', () => {
  const off = renderToStaticMarkup(createElement(Avatar, { name: 'Hanako Bango', hash: null }));
  assert.equal(off, '<span class="avatar" aria-hidden="true">H</span>');
  assert.doesNotMatch(off, /gravatar/i);
  assert.doesNotMatch(off, /<img/);
  // Absent and null are the same absence of consent.
  assert.equal(renderToStaticMarkup(createElement(Avatar, { name: 'Hanako Bango' })), off);
  // A nameless account still renders something rather than an empty circle.
  assert.match(renderToStaticMarkup(createElement(Avatar, { name: '   ', hash: null })), />\?</);

  const on = renderToStaticMarkup(createElement(Avatar, {
    name: 'Hanako Bango', hash: gravatarIdentifier('bango@example.com'), size: 32,
  }));
  assert.match(on, /<img/);
  assert.match(on, /https:\/\/gravatar\.com\/avatar\//);
  // Requested at twice the rendered size, and never as a referrer leak.
  assert.match(on, /s=64/);
  assert.match(on, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/);
  assert.doesNotMatch(on, /@/);
});
