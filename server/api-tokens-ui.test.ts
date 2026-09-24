import './dom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiTokens, IssuedSecretDialog, type ApiTokenView } from '../web/api-tokens.js';
import { mount } from './dom-render.js';
import { apiTokenCreateInput } from '../web/api-token-form.js';

const ordinary: ApiTokenView = {
  id: 'token-1', label: 'Stocktake importer', admin: false,
  createdAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z',
};
const permanent: ApiTokenView = {
  id: 'token-2', label: 'Bench agent', admin: true,
  createdAt: '2026-09-02T00:00:00.000Z', expiresAt: null,
};
const render = (props: Parameters<typeof ApiTokens>[0]) =>
  renderToStaticMarkup(createElement(ApiTokens, props));

/** The dialogs are anchored in portals, so they are opened and read in a real
 * document rather than matched against a markup string. */
const open = (props: Parameters<typeof ApiTokens>[0], action: string | RegExp) => {
  const view = mount(createElement(ApiTokens, props));
  view.click(view.button(action));
  return view;
};

test('API token management is a credential surface, not a session list', () => {
  const empty = render({ tokens: [], maxLifetimeDays: null, isAdmin: false });
  assert.match(empty, />API tokens</);
  // Creating is always available, so an empty surface still offers the action
  // rather than leaving a form hanging over nothing.
  assert.match(empty, />Create token</);
  assert.match(empty, /No API tokens yet\./);
  assert.match(empty, /Create one when a program needs to act for you\./);

  const listed = render({ tokens: [ordinary, permanent], maxLifetimeDays: null, isAdmin: false });
  assert.match(listed, />Stocktake importer</);
  assert.match(listed, />Bench agent</);
  assert.match(listed, /2026\/10\/01/);
  assert.match(listed, />Never</);
  assert.doesNotMatch(listed, /No API tokens yet/);
  // The list stays minimal: no browser sessions, no last-used, and none of the
  // credential machinery underneath.
  for (const leak of [/session/i, /bearer/i, /Better Auth/i, /lastUsed/i, /last used/i]) {
    assert.doesNotMatch(listed, leak, String(leak));
  }
  assert.doesNotMatch(listed, /secret/i);

  // Revocation is per token, named for assistive technology, and confirmed
  // before it happens rather than on the click that asked for it.
  const view = open({ tokens: [ordinary, permanent], maxLifetimeDays: null, isAdmin: false },
    'Revoke Stocktake importer');
  assert.equal(view.dialogName(), 'Revoke this token?');
  assert.match(view.text(), /Anything still using “Stocktake importer”/);
  assert.ok(view.button('Cancel'), 'the safe answer is offered');
  assert.ok(view.button('Revoke token'), 'and so is the destructive one');
  view.stop();
});

test('the administrator choice appears only for an administrator, in plain words', () => {
  const view = open({ tokens: [permanent, ordinary], maxLifetimeDays: null, isAdmin: true }, 'Create token');
  const admin = view.html();
  // Not a naked domain noun, and not IAM vocabulary.
  assert.match(admin, /Let this token use your administrator access/);
  assert.doesNotMatch(admin, /Can administer this instance/);
  assert.doesNotMatch(admin, /\bscopes?\b/i);
  assert.doesNotMatch(admin, /permission/i);
  // Explanation is available rather than compulsory reading.
  assert.match(admin, />What this allows</);
  assert.match(admin, /stops being\s+able to the moment you are no longer an administrator/);
  // It must never read as widening Asset access.
  assert.match(admin, /does not reach any Asset[\s\S]*Groups you already belong to/);
  assert.doesNotMatch(admin, /all Assets/i);
  // The list distinguishes the two kinds only where the distinction is offered.
  const listed = render({ tokens: [permanent, ordinary], maxLifetimeDays: null, isAdmin: true });
  assert.match(listed, />Administrator</);
  assert.match(listed, />Standard</);
  view.stop();

  const plain = open({ tokens: [permanent], maxLifetimeDays: null, isAdmin: false }, 'Create token');
  assert.doesNotMatch(plain.text(), /administrator access/i);
  assert.doesNotMatch(plain.text(), /Standard/);
  plain.stop();
});

test('lifetime choices come from instance policy rather than the browser', () => {
  const never = (view: ReturnType<typeof mount>) =>
    view.field('input[name="lifetime"][value="never"]');

  const unbounded = open({ tokens: [], maxLifetimeDays: null, isAdmin: false }, 'Create token');
  assert.match(unbounded.text(), /Never expires/);
  assert.match(unbounded.text(), /Expiry is fixed when the token is created and does not extend with use\./);
  assert.equal(never(unbounded)?.disabled, false);
  unbounded.stop();

  const bounded = open({ tokens: [], maxLifetimeDays: 30, isAdmin: false }, 'Create token');
  assert.match(bounded.text(), /This instance allows at most 30 days, so a token must expire\./);
  const days = bounded.field('input[type="number"]');
  assert.equal(days?.max, '30');
  assert.equal(days?.value, '30', 'the ceiling is the starting point when there is one');
  // The forbidden choice is visible but unavailable, so the policy is legible
  // rather than mysterious.
  assert.equal(never(bounded)?.disabled, true);
  bounded.stop();
});

test('token creation input is validated against instance policy before it is sent', () => {
  const base = { label: 'Importer', expires: true, days: '30', admin: false, isAdmin: false, maxLifetimeDays: null };
  assert.deepEqual(apiTokenCreateInput(base).body, { label: 'Importer', lifetimeDays: 30, admin: false });
  assert.match(apiTokenCreateInput({ ...base, label: '   ' }).error ?? '', /name/i);
  for (const days of ['', '0', '-1', '1.5', 'thirty']) {
    assert.match(apiTokenCreateInput({ ...base, days }).error ?? '', /whole number of days/, days);
  }
  assert.deepEqual(apiTokenCreateInput({ ...base, expires: false }).body,
    { label: 'Importer', lifetimeDays: null, admin: false });
  assert.match(apiTokenCreateInput({ ...base, expires: false, maxLifetimeDays: 30 }).error ?? '',
    /expire within 30 days/);
  assert.match(apiTokenCreateInput({ ...base, days: '31', maxLifetimeDays: 30 }).error ?? '',
    /at most 30 days/);
  // The form can never ask for a capability its owner does not hold; the
  // server refuses it as well, and this only keeps the request honest.
  assert.equal(apiTokenCreateInput({ ...base, admin: true, isAdmin: false }).body?.admin, false);
  assert.equal(apiTokenCreateInput({ ...base, admin: true, isAdmin: true }).body?.admin, true);
});

test('the one-time secret is a calm focused dialog with an in-field copy', () => {
  const view = mount(createElement(IssuedSecretDialog, {
    issued: { label: 'Stocktake importer', secret: 'kannabi-test-secret-value' }, onDismiss() {},
  }));
  assert.equal(view.dialogName(), 'Copy “Stocktake importer”');
  assert.match(view.text(), /This token is shown once\. Store it now/);
  assert.match(view.text(), /revoke it and create another/);
  // Informative, not destructive: nothing has gone wrong, so nothing alarms.
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(view.dialog()?.getAttribute('role'), 'dialog', 'not an alert dialog');
  // The value is in a field that can be selected and copied, not loose text.
  const secret = view.field('input[readonly]');
  assert.equal(secret?.value, 'kannabi-test-secret-value');
  assert.ok(view.button('Copy API token'), 'copying is an in-field affordance');
  assert.ok(view.button('I have stored it'));
  // Nothing durable holds the value.
  for (const leak of [/localStorage/, /sessionStorage/, /href=/, /console\./]) {
    assert.doesNotMatch(view.html(), leak, String(leak));
  }
  view.stop();
});
