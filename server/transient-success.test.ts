import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TransientSuccess, transientExitDuration, transientSuccessDuration,
  type TransientTone } from '../web/transient-success.js';

const render = (tone?: TransientTone, label = 'Saved') =>
  renderToStaticMarkup(createElement(TransientSuccess, { trigger: 'x', label, tone }));
const stylesheet = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');

test('an auto-dismissing message shows how long it has left', () => {
  const markup = render();
  // Announced without stealing focus, as ordinary progress feedback.
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/);
  // The lifetime is a real element carrying the timer's own duration, so the
  // bar and the dismissal cannot disagree about how long is left.
  assert.match(markup, /class="transient-lifetime"/);
  assert.match(markup, new RegExp(`animation-duration:${transientSuccessDuration}ms`));
  assert.match(markup, /aria-hidden="true"/);
  assert.equal(transientSuccessDuration, 3000);
  assert.ok(transientExitDuration > 0 && transientExitDuration < transientSuccessDuration);
});

test('waiting is never the only way out', () => {
  const markup = render(undefined, 'Allocated');
  // A dismiss control that names what it dismisses, for anybody who cannot
  // read the message before the timer does.
  assert.match(markup, /class="transient-dismiss"/);
  assert.match(markup, /aria-label="Dismiss: Allocated"/);
  assert.match(markup, /type="button"/);
  // Nothing is rendered at all without something to report.
  assert.equal(renderToStaticMarkup(createElement(TransientSuccess,
    { trigger: null, label: 'Saved' })), '');
});

test('success, error and neutral stay distinguishable', () => {
  assert.match(render('success'), /class="settings-status-pill saved transient-success"/);
  assert.match(render('error'), /class="settings-status-pill error transient-success"/);
  assert.match(render('info'), /class="settings-status-pill transient-success"/);
  // Not colour alone: the error carries its own mark.
  assert.match(render('error'), />!</);
  assert.match(render('success'), />✓</);
  // Success is the default, so every existing caller keeps its meaning.
  assert.equal(render('success'), render());
});

test('reduced motion drops the movement and keeps the countdown', () => {
  const reduced = stylesheet.slice(stylesheet.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.transient-success[^}]*animation: none/);
  // The lifetime rule is information rather than decoration, so it is not
  // among the animations reduced motion removes.
  assert.doesNotMatch(reduced.slice(0, reduced.indexOf('}')), /transient-lifetime/);
  assert.match(stylesheet, /@keyframes transient-lifetime/);
  // Hovering or focusing holds it, so the dismiss control is reachable.
  assert.match(stylesheet, /\.transient-success\.paused \.transient-lifetime \{ animation-play-state: paused; \}/);
});
