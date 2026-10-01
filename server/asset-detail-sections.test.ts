import './dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { AssetView } from '../web/asset-view.js';
import AssetPage, { clientAction as assetAction } from '../web/routes/asset.js';
import { mount, settle } from './dom-render.js';
import { newAssetId } from './asset-id.js';

/** How the Asset page folds, and how the two things a person can change are
 * reached now that the edit form is gone.
 *
 * The page grows a section per capability, so what starts open is a judgement
 * about what someone came for. These assert the judgement rather than the
 * markup: a `<details>` reports its own state, which is also what assistive
 * technology reads.
 */

const id = newAssetId();
const sourceRecord = {
  reference: 'legacy:asset:1483',
  recordedAt: '2019-04-12T09:30:00.000Z',
  recordedBy: 'A. Rivera',
};

function loaderData(asset: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
  return {
    asset: {
      id, name: 'Inspection camera', isPublic: false, owner: null,
      groups: [{ key: 'workshop', name: 'Workshop' }],
      reportedBy: { key: 'alex', name: 'Alex', status: 'active' as const },
      reportedAt: '2026-09-29T11:00:00.000Z',
      identifiers: [], photos: [], issuances: [], provenance: null, sourceRecord: null, ...asset,
    },
    canEdit: true, canViewReporterProfile: false, authenticated: true,
    settings: { displayTimezone: 'UTC', showAssetId: false, showIdentifierPolicyVersion: false },
    digitalLinks: {}, nativeUri: `http://127.0.0.1/asset/${id}`,
    surfacedUri: `http://127.0.0.1/asset/${id}`,
    namespaces: [], classKeys: [], controlled: [], canGrant: false, ...rest,
  };
}

function render(asset: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
  const router = createMemoryRouter(
    [{ path: '/asset/:id', element: createElement(AssetView, loaderData(asset, rest) as never) }],
    { initialEntries: [`/asset/${id}`] });
  return mount(createElement(RouterProvider, { router }));
}

/** A section by its heading, with the disclosure that owns it. */
function section(title: string): HTMLDetailsElement | null {
  for (const summary of document.querySelectorAll('summary')) {
    if (summary.textContent?.trim() === title) return summary.closest('details');
  }
  return null;
}

test('the page arrives showing what it is for and folds the rest away', () => {
  const view = render({ sourceRecord });
  try {
    // Identity is why someone opens an Asset, so it is the one thing waiting.
    assert.equal(section('Identifiers')?.open, true);
    for (const folded of ['Details', 'Photos', 'Source record', 'Manage Groups']) {
      assert.equal(section(folded)?.open ?? 'missing', false, `${folded} should arrive folded`);
    }
  } finally { view.stop(); }
});

test('a folded section still opens, and a reader can open several', async () => {
  const view = render({ sourceRecord });
  try {
    const details = section('Details')!;
    // The summary is the control, and the browser gives it its own role and
    // keyboard handling; nothing here re-implements that.
    await settle(() => details.querySelector('summary')!.click());
    assert.equal(details.open, true);
    assert.equal(section('Identifiers')?.open, true, 'opening one must not close another');
  } finally { view.stop(); }
});

test('an Asset with no source attribution renders no Source record section', () => {
  const view = render();
  try {
    assert.equal(section('Source record'), null);
    assert.equal(section('Identifiers')?.open, true);
  } finally { view.stop(); }
});

test('quoted source evidence still reads correctly once its section is opened', async () => {
  const view = render({ sourceRecord });
  try {
    const details = section('Source record')!;
    await settle(() => details.querySelector('summary')!.click());
    assert.equal(details.open, true);
    const terms = [...details.querySelectorAll('dt')].map((node) => node.textContent?.trim());
    assert.ok(terms.includes('Source states recorded by'));
    assert.match(details.textContent ?? '', /A\. Rivera/);
    assert.match(details.textContent ?? '', /legacy:asset:1483/);
    // Still its own section, so a quoted time cannot sit beside Reported.
    assert.notEqual(details, section('Details'));
  } finally { view.stop(); }
});

test('visibility reads as a word and changes only through a named confirmation', async () => {
  const view = render();
  try {
    const details = section('Details')!;
    // The state is text, not the position of a control.
    assert.match(details.textContent ?? '', /Private/);
    assert.ok(details.querySelector('[role="switch"]') === null,
      'publishing is consequential, so it is not a one-click toggle');

    await settle(() => view.button('Change visibility')!.click());
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]')!;
    assert.match(dialog.textContent ?? '', /Make this Asset public\?/);
    assert.match(dialog.textContent ?? '', /Anyone with this Asset’s address will be able to read it/);
    // It must not imply public editing.
    assert.match(dialog.textContent ?? '', /editing stays with the Groups/);
    // The action names the outcome rather than agreeing to an unnamed one.
    assert.ok(view.button('Make public'), 'the confirming action names the transition');
    assert.ok(view.button('Cancel'));
    // Publishing is a property of the Asset, not a Group association.
    assert.ok(section('Manage Groups')!.textContent?.includes('Change visibility') !== true);
  } finally { view.stop(); }
});

test('a public Asset offers the opposite transition, also named', async () => {
  const view = render({ isPublic: true });
  try {
    assert.match(section('Details')!.textContent ?? '', /Public/);
    await settle(() => view.button('Change visibility')!.click());
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]')!;
    assert.match(dialog.textContent ?? '', /Make this Asset private\?/);
    assert.ok(view.button('Make private'));
  } finally { view.stop(); }
});

test('the visibility transition sends only isPublic, once confirmed', async () => {
  const calls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ asset: {} }), { headers: { 'Content-Type': 'application/json' } });
  };
  const router = createMemoryRouter([{
    path: '/assets/:id',
    element: createElement(AssetPage, { loaderData: loaderData() } as never),
    action: (args) => assetAction(args as never),
  }], { initialEntries: [`/assets/${id}`] });
  const view = mount(createElement(RouterProvider, { router }));
  try {
    await settle(() => view.button('Change visibility')!.click());
    assert.deepEqual(calls, [], 'nothing happens until it is confirmed');
    await settle(() => view.button('Make public')!.click());
    await settle();
    assert.deepEqual(calls, [{ path: `/api/assets/${id}`, method: 'PATCH', body: { isPublic: true } }]);
  } finally {
    view.stop();
    globalThis.fetch = originalFetch;
  }
});

test('Owner is an unfinished note rather than a fact or a disabled control', () => {
  const view = render();
  try {
    const details = section('Details')!;
    const owner = [...details.querySelectorAll('dt')]
      .find((node) => node.textContent?.trim() === 'Owner')!.nextElementSibling!;
    assert.match(owner.textContent ?? '', /Not implemented yet/);
    // Visibly demoted, and text rather than a control: nothing here is
    // focusable, so it cannot read as something temporarily switched off.
    assert.match(owner.querySelector('span')?.className ?? '', /text-muted-foreground/);
    assert.equal(owner.querySelector('button, input, select, a'), null);
  } finally { view.stop(); }
});

test('a reader who cannot edit is offered neither control', () => {
  const view = render({ sourceRecord }, { canEdit: false });
  try {
    assert.match(section('Details')!.textContent ?? '', /Private/);
    assert.equal(view.button('Change visibility'), null);
    assert.equal(view.button(/^Rename/), null);
    assert.equal(section('Manage Groups'), null);
  } finally { view.stop(); }
});

test('the Asset name is edited in place, and cancelling restores it', async () => {
  const view = render();
  try {
    assert.match(document.querySelector('h1')?.textContent ?? '', /Inspection camera/);
    assert.equal(document.querySelector('input[name="name"]'), null, 'no permanent field');

    const rename = view.button('Rename Inspection camera')!;
    assert.ok(rename, 'the affordance names what it renames');
    await settle(() => rename.click());
    const field = view.field('input[name="name"]')!;
    assert.ok(field, 'editing exposes the field in the heading itself');
    assert.equal(field.getAttribute('aria-label'), 'Asset name');
    assert.equal(field.value, 'Inspection camera');

    field.value = 'Changed my mind';
    // Leaving the field abandons the edit, but not silently when there is
    // something to lose: what was typed is the only copy of it.
    // React delivers onBlur through focusout, which is the bubbling one.
    await settle(() => field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    assert.match(document.querySelector('[role="alertdialog"], [role="dialog"]')?.textContent ?? '',
      /Discard this name\?/);
    assert.ok(view.field('input[name="name"]'), 'and the edit is still there to keep');
    await settle(() => view.button('Discard')!.click());
    assert.ok(document.querySelector('input[name="name"]') === null, 'the field is gone');
    assert.match(document.querySelector('h1')?.textContent ?? '', /Inspection camera/,
      'cancelling restores the current value rather than keeping the typed one');
  } finally { view.stop(); }
});

test('Escape on an untouched rename closes it silently', async () => {
  const view = render();
  try {
    await settle(() => view.button('Rename Inspection camera')!.click());
    const field = view.field('input[name="name"]')!;
    // Nothing typed, so nothing to lose and nothing to ask about.
    await settle(() => field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.ok(document.querySelector('[role="alertdialog"], [role="dialog"]') === null,
      'an untouched field must not ask about discarding');
    assert.ok(document.querySelector('input[name="name"]') === null);
    assert.match(document.querySelector('h1')?.textContent ?? '', /Inspection camera/);
  } finally { view.stop(); }
});

test('Escape on a changed rename asks before discarding, and can be kept', async () => {
  const view = render();
  try {
    await settle(() => view.button('Rename Inspection camera')!.click());
    const field = view.field('input[name="name"]')!;
    field.value = 'Abandoned';
    await settle(() => field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
    assert.match(dialog?.textContent ?? '', /Discard this name\?/);
    // It names what the Asset would keep, so the choice is between two known
    // values rather than between "discard" and an unstated alternative.
    assert.match(dialog?.textContent ?? '', /Inspection camera/);
    // Keeping it returns the reader to what they typed rather than losing it.
    await settle(() => view.button('Keep editing')!.click());
    assert.equal(view.field('input[name="name"]')?.value, 'Abandoned');
  } finally { view.stop(); }
});

test('a rename that changes nothing closes the editor without a mutation', async () => {
  const view = render();
  try {
    await settle(() => view.button('Rename Inspection camera')!.click());
    view.field('input[name="name"]')!.value = '   ';
    await settle(() => view.button('Save name')!.click());
    assert.ok(document.querySelector('input[name="name"]') === null,
      'an empty name closes the editor rather than sending a mutation the domain would refuse');
    assert.match(document.querySelector('h1')?.textContent ?? '', /Inspection camera/);
  } finally { view.stop(); }
});

test('a refused rename keeps the field open, says why, and does not pretend it saved', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: 'That name is already taken' }),
    { status: 400, headers: { 'Content-Type': 'application/json' } });
  const router = createMemoryRouter([{
    path: '/assets/:id',
    element: createElement(AssetPage, { loaderData: loaderData() } as never),
    action: (args) => assetAction(args as never),
  }], { initialEntries: [`/assets/${id}`] });
  const view = mount(createElement(RouterProvider, { router }));
  try {
    await settle(() => view.button('Rename Inspection camera')!.click());
    view.field('input[name="name"]')!.value = 'Taken name';
    await settle(() => view.button('Save name')!.click());
    await settle();

    const field = view.field('input[name="name"]');
    assert.ok(field, 'the field stays open so the typed name is not lost');
    assert.equal(field!.value, 'Taken name');
    const alert = document.querySelector('[role="alert"]');
    assert.match(alert?.textContent ?? '', /already taken/, 'the reason is announced');
    // The heading has not adopted a name the server refused.
    assert.doesNotMatch(document.querySelector('h1')?.textContent ?? '', /Taken name/);
  } finally {
    view.stop();
    globalThis.fetch = originalFetch;
  }
});

test('adding an identifier is folded away, and is two tabs before it is a form', async () => {
  const view = render({}, { namespaces: [{ key: 'n', gcp: '0614141' }] });
  try {
    const add = [...document.querySelectorAll('summary')]
      .find((node) => node.textContent?.trim() === 'Add identifier')!.closest('details')!;
    assert.equal(add.open, false, 'operations wait until somebody wants to perform one');

    await settle(() => add.querySelector('summary')!.click());
    // Tabs rather than radios beside their own help buttons, which read as
    // four similar round controls.
    const tabs = [...add.querySelectorAll('[role="tab"]')] as HTMLElement[];
    assert.deepEqual(tabs.map((tab) => tab.textContent?.trim()), ['Issue new', 'Record existing']);
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
    assert.equal(add.querySelectorAll('input[type="radio"]').length, 0);

    // One sentence for the active mode, and only its form. Read the live panel
    // rather than the whole section: the inactive mode's name is still on its
    // own tab, so a search across the section would find it either way.
    const panel = () => add.querySelector('[role="tabpanel"]')!;
    assert.match(panel().textContent ?? '', /Issue an identifier under a GS1 Company Prefix namespace/);
    assert.ok(panel().querySelector('button[type="submit"]'), 'issuing is offered');
    assert.ok(panel().querySelector('select[name="scheme"]') === null,
      'recording is not also open');

    await settle(() => tabs[1].click());
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
    assert.match(panel().textContent ?? '', /already been assigned outside Kannabi/);
    assert.ok(!/Issue an identifier under a GS1 Company Prefix/.test(panel().textContent ?? ''),
      'the other mode\u2019s explanation went with its panel');
    assert.ok(panel().querySelector('select[name="scheme"]'), 'recording is offered once chosen');
  } finally { view.stop(); }
});

test('an identifier is not detached until the consequence has been accepted', async () => {
  const gtin = { key: 'i1', scheme: 'gtin' as const, canonical: '(01)00614141123452',
    level: 'class' as const, components: { gtin: '00614141123452' }, policyVersion: 'x' };
  const view = render({ identifiers: [gtin] });
  try {
    assert.match(document.body.textContent ?? '', /Recorded IDs/,
      'identifiers are headed once there are some');
    await settle(() => view.button(/^Detach GTIN/)!.click());
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
    assert.ok(dialog, 'removing an identity asks first');
    assert.match(dialog!.textContent ?? '', /will no longer identify this Asset/);
    assert.ok(view.button('Cancel'), 'and the safe answer is offered');
  } finally { view.stop(); }
});

test('an Asset with no identifiers heads no empty group', () => {
  const view = render();
  try {
    assert.doesNotMatch(document.body.textContent ?? '', /Recorded IDs/);
    assert.match(document.body.textContent ?? '', /No identifiers recorded/);
  } finally { view.stop(); }
});

test('contextual help opens on a click and stays, and is reachable by keyboard', async () => {
  const view = render();
  try {
    // The rule about what publishing does is worth reading once.
    assert.doesNotMatch(document.body.textContent ?? '', /Editing still requires Group access/);
    const help = view.button('About visibility')!;
    assert.ok(help, 'the explanation has an affordance of its own');
    assert.equal(help.getAttribute('aria-expanded'), 'false');

    // Clicking is what people do with a question mark, and it must open rather
    // than dismiss: a tooltip closed again on click, which is why this is a
    // popover.
    await settle(() => help.click());
    assert.equal(help.getAttribute('aria-expanded'), 'true');
    assert.match(document.body.textContent ?? '', /Editing still requires Group access/);

    // And it stays: reading it does not require holding a pointer still.
    await settle();
    assert.match(document.body.textContent ?? '', /Editing still requires Group access/);

    // Escape dismisses, which is the keyboard's way out.
    await settle(() => document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(help.getAttribute('aria-expanded'), 'false');
  } finally { view.stop(); }
});

test('a scheme name points at GS1 rather than at a Kannabi explanation', async () => {
  const sgtin = { key: 'i1', scheme: 'sgtin' as const, canonical: '(01)00614141123452(21)1',
    level: 'individual' as const,
    components: { gtin: '00614141123452', serial: '1' }, policyVersion: 'x' };
  const view = render({ identifiers: [sgtin] });
  try {
    // What an SGTIN is belongs to GS1, so it is a link out, not Kannabi's own
    // help affordance.
    assert.equal(view.button('About SGTIN'), null,
      'a GS1 key definition is not a Kannabi concept');
    const link = [...document.querySelectorAll('a')]
      .find((anchor) => anchor.textContent?.trim() === 'SGTIN')!;
    assert.ok(link, 'the scheme name is the reference');
    // AI 21 is the association that makes a GTIN serialised; AI 01 alone is a
    // GTIN, so this is the AI that distinguishes the scheme.
    assert.equal(link.getAttribute('href'), 'https://ref.gs1.org/ai/21');
    assert.equal(link.getAttribute('target'), '_blank');
    assert.match(link.getAttribute('rel') ?? '', /noopener/);
    assert.match(link.getAttribute('aria-label') ?? '', /GS1 reference/);
    // The one-line orientation stays, stated once.
    const card = link.closest('li')!;
    assert.match(card.textContent ?? '', /Serialised trade item/);
    assert.equal(card.textContent?.match(/identifies this Asset/gi)?.length, 1);
  } finally { view.stop(); }
});
