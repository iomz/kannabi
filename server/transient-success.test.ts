import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TransientSuccess, transientExitDuration, transientSuccessDuration,
  type TransientTone } from '../web/transient-success.js';

const render = (tone?: TransientTone, label = 'Saved') =>
  renderToStaticMarkup(createElement(TransientSuccess, { trigger: 'x', label, tone }));

/** The classes on one element of the rendered message. */
function classesOf(markup: string, selector: RegExp): string[] {
  const element = selector.exec(markup);
  assert.ok(element, `expected ${selector} in ${markup}`);
  return (/class="([^"]*)"/.exec(element[0])?.[1] ?? '').split(/\s+/);
}

const message = /<span [^>]*role="status"[^>]*>/;
const lifetime = /<span [^>]*data-slot="transient-lifetime"[^>]*>/;

test('an auto-dismissing message shows how long it has left', () => {
  const markup = render();
  // Announced without stealing focus, as ordinary progress feedback.
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/);
  // The lifetime is a real element carrying the timer's own duration, so the
  // bar and the dismissal cannot disagree about how long is left.
  assert.match(markup, /data-slot="transient-lifetime"/);
  assert.match(markup, new RegExp(`animation-duration:${transientSuccessDuration}ms`));
  assert.match(markup, /aria-hidden="true"/);
  assert.equal(transientSuccessDuration, 3000);
  assert.ok(transientExitDuration > 0 && transientExitDuration < transientSuccessDuration);
});

test('waiting is never the only way out', () => {
  const markup = render(undefined, 'Allocated');
  // A dismiss control that names what it dismisses, for anybody who cannot
  // read the message before the timer does.
  assert.match(markup, /aria-label="Dismiss: Allocated"/);
  assert.match(markup, /type="button"/);
  // Nothing is rendered at all without something to report.
  assert.equal(renderToStaticMarkup(createElement(TransientSuccess,
    { trigger: null, label: 'Saved' })), '');
});

test('success, error and neutral stay distinguishable', () => {
  assert.match(render('success'), /data-tone="success"/);
  assert.match(render('error'), /data-tone="error"/);
  assert.match(render('info'), /data-tone="info"/);
  // Not colour alone: the error carries its own mark.
  assert.match(render('error'), />!</);
  assert.match(render('success'), />✓</);
  // Each tone reaches for its own surface rather than sharing one.
  const surface = (tone: TransientTone) =>
    classesOf(render(tone), message).find((name) => name.startsWith('bg-'));
  assert.equal(new Set((['success', 'error', 'info'] as const).map(surface)).size, 3);
  // Success is the default, so every existing caller keeps its meaning.
  assert.equal(render('success'), render());
});

test('reduced motion drops the movement and keeps the countdown', () => {
  const markup = render();
  // The message's arrival and departure are decoration, so they go.
  assert.ok(classesOf(markup, message).includes('motion-reduce:animate-none'));
  assert.ok(classesOf(markup, message).some((name) => name.startsWith('animate-transient-')));
  // The countdown is the only thing saying when this disappears, so removing
  // it would hide the state rather than calm it. It is not reduced.
  const bar = classesOf(markup, lifetime);
  assert.ok(bar.includes('animate-transient-lifetime'));
  assert.ok(!bar.includes('motion-reduce:animate-none'));
});
