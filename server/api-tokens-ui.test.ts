import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiTokens, IssuedSecretDialog, type ApiTokenView } from '../web/api-tokens.js';
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
  // Revocation is per token, named for assistive technology, and confirmed.
  assert.match(listed, /aria-label="Revoke Stocktake importer"/);
  assert.match(listed, /aria-label="Revoke Bench agent"/);
  assert.match(listed, /Anything still using/);
  assert.match(listed, /aria-label="Close revocation dialog"/);
  assert.doesNotMatch(listed, /secret/i);
});

test('the administrator choice appears only for an administrator, in plain words', () => {
  const admin = render({ tokens: [permanent, ordinary], maxLifetimeDays: null, isAdmin: true });
  // Not a naked domain noun, and not IAM vocabulary.
  assert.match(admin, /Let this token use your administrator access/);
  assert.doesNotMatch(admin, /Can administer this instance/);
  assert.doesNotMatch(admin, /\bscopes?\b/i);
  assert.doesNotMatch(admin, /permission/i);
  // Explanation is available rather than compulsory reading.
  assert.match(admin, /<summary>What this allows<\/summary>/);
  assert.match(admin, /stops being\s+able to the moment you are no longer an administrator/);
  // It must never read as widening Asset access.
  assert.match(admin, /does not reach any Asset[\s\S]*Groups you already belong to/);
  assert.doesNotMatch(admin, /all Assets/i);
  // The list distinguishes the two kinds only where the distinction is offered.
  assert.match(admin, />Administrator</);
  assert.match(admin, />Standard</);
  const plain = render({ tokens: [permanent], maxLifetimeDays: null, isAdmin: false });
  assert.doesNotMatch(plain, /administrator access/i);
  assert.doesNotMatch(plain, />Standard</);
});

test('lifetime choices come from instance policy rather than the browser', () => {
  const open = render({ tokens: [], maxLifetimeDays: null, isAdmin: false });
  assert.match(open, /Never expires/);
  assert.match(open, /Expiry is fixed when the token is created and does not extend with use\./);
  assert.doesNotMatch(open, /<input type="radio" disabled="" name="lifetime" value="never"/);

  const bounded = render({ tokens: [], maxLifetimeDays: 30, isAdmin: false });
  assert.match(bounded, /This instance allows at most 30 days, so a token must expire\./);
  assert.match(bounded, /max="30"/);
  assert.match(bounded, /value="30"/);
  // The forbidden choice is visible but unavailable, so the policy is legible
  // rather than mysterious.
  assert.match(bounded, /<input type="radio" disabled="" name="lifetime" value="never"/);
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
  const markup = renderToStaticMarkup(createElement(IssuedSecretDialog, {
    issued: { label: 'Stocktake importer', secret: 'kannabi-test-secret-value' }, onDismiss() {},
  }));
  assert.match(markup, /<dialog[^>]+aria-labelledby=/);
  assert.match(markup, /Copy “Stocktake importer”/);
  assert.match(markup, /This token is shown once\. Store it now/);
  assert.match(markup, /revoke it and create another/);
  // Informative, not destructive: no danger styling and no alarm role.
  assert.match(markup, /class="notice"/);
  assert.doesNotMatch(markup, /class="[^"]*danger/);
  assert.doesNotMatch(markup, /role="alert"/);
  // The copy affordance is the shared in-field icon control, not a separate button.
  assert.match(markup, /class="copy-field"/);
  assert.match(markup, /class="asset-uri-control"/);
  assert.match(markup, /aria-label="Copy API token"/);
  assert.match(markup, /readOnly=""|readonly=""/);
  assert.match(markup, /kannabi-test-secret-value/);
  assert.match(markup, />I have stored it</);
  // Nothing durable holds the value.
  for (const leak of [/localStorage/, /sessionStorage/, /href=/, /console\./]) {
    assert.doesNotMatch(markup, leak, String(leak));
  }
});
