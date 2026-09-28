import './dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { AssetUri, copyAssetUri } from '../web/asset-uri.js';
import { assetPath, assetPhotoPath } from '../shared/asset-uri.js';
import { newAssetId } from './asset-id.js';
import { mount } from './dom-render.js';

const origin = 'https://kannabi.example';

test('the native Asset URI is the native ID path and is copied complete', () => {
  const id = newAssetId();
  assert.equal(assetPath(id), '/asset/' + id);
  const uri = new URL(assetPath(id), origin).toString();
  assert.equal(uri, `${origin}/asset/${id}`);
  assert.equal(uri.includes('?'), false);
  assert.equal(assetPhotoPath(id, 'photo-key'), `/api/assets/${id}/photos/photo-key`);
});

test('an Asset with no Digital Link identity shows one URI, labelled plainly', () => {
  const uri = `${origin}/asset/${newAssetId()}`;
  const view = mount(createElement(AssetUri, { surfacedUri: uri, nativeUri: uri, showNativeUri: true }));
  try {
    const fields = [...document.querySelectorAll('input')];
    assert.equal(fields.length, 1);
    assert.equal(fields[0].value, uri);
    assert.match(view.text(), /Asset URI/);
    // Nothing suggests the Asset is missing something it ought to have.
    assert.doesNotMatch(view.text(), /Digital Link/);
  } finally { view.stop(); }
});

test('a surfaced Digital Link is offered first and the native URI stays reachable', () => {
  const nativeUri = `${origin}/asset/${newAssetId()}`;
  const surfacedUri = `${origin}/8004/0614141ASSET-001`;
  const view = mount(createElement(AssetUri, { surfacedUri, nativeUri, showNativeUri: true }));
  try {
    const fields = [...document.querySelectorAll('input')];
    assert.deepEqual(fields.map((field) => field.value), [surfacedUri, nativeUri]);
    // Each is copyable under its own accessible name.
    const copies = [...document.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'));
    assert.deepEqual(copies, ['Copy GS1 Digital Link URI', 'Copy Kannabi Asset URI']);
    // The word the standard reserves for the id.gs1.org form is never
    // claimed for either of these.
    assert.doesNotMatch(view.text(), /canonical Asset URI|canonical GS1 Digital Link URI for/);
    assert.match(view.text(), /not a canonical GS1 Digital Link URI/);
    // The native URI is described as durable rather than as a fallback.
    assert.match(view.text(), /never changes and stays valid/);
  } finally { view.stop(); }
});

test('the copy control hands over the exact value it displays', async () => {
  const uri = `${origin}/01/00614141123452/21/aB%2Fc%25D`;
  let copied = '';
  await copyAssetUri(uri, { writeText: async (value) => { copied = value; } });
  assert.equal(copied, uri);
});

test('the native Asset URI follows the instance Kannabi ID setting', () => {
  const nativeUri = `${origin}/asset/${newAssetId()}`;
  const surfacedUri = `${origin}/8004/0614141ASSET-001`;
  const view = mount(createElement(AssetUri, { surfacedUri, nativeUri, showNativeUri: false }));
  try {
    // The Digital Link is surfaced exactly as before.
    const fields = [...document.querySelectorAll('input')];
    assert.deepEqual(fields.map((field) => field.value), [surfacedUri]);
    assert.match(view.text(), /GS1 Digital Link URI/);
    // The UUIDv7 does not appear anywhere, which is the point of the setting.
    assert.doesNotMatch(view.text(), /Kannabi Asset URI/);
    assert.equal(view.text().includes(nativeUri), false);
  } finally { view.stop(); }
});

test('with the setting off and no Digital Link, no address is put in front of a person', () => {
  const uri = `${origin}/asset/${newAssetId()}`;
  const view = mount(createElement(AssetUri, { surfacedUri: uri, nativeUri: uri, showNativeUri: false }));
  try {
    // The address is unchanged and still resolves; it is simply not shown,
    // which is what the deployment asked for by turning the setting off.
    assert.equal(document.querySelectorAll('input').length, 0);
    assert.equal(view.text().includes(uri), false);
  } finally { view.stop(); }
});
