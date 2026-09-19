import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PhotoDeleteConfirmation } from '../web/photo-delete-confirmation.js';

test('photo deletion uses a single-step accessible destructive dialog', () => {
  const markup = renderToStaticMarkup(createElement(PhotoDeleteConfirmation, {
    open: false,
    busy: false,
    error: null,
    onClose() {},
    onConfirm() {},
  }));
  assert.match(markup, /<dialog[^>]+aria-labelledby=/);
  assert.match(markup, />Delete photo\?</);
  assert.match(markup, /permanently removed from this Asset/);
  assert.match(markup, />Cancel</);
  assert.match(markup, />Delete photo</);
  assert.match(markup, /aria-label="Close photo deletion dialog"/);
});
