import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Switch } from '../web/switch.js';

test('switch preserves native form and accessible checked-state semantics', () => {
  const markup = renderToStaticMarkup(createElement(Switch, {
    label: 'Public access', name: 'isPublic', defaultChecked: true,
  }));
  assert.match(markup, /type="checkbox"/);
  assert.match(markup, /role="switch"/);
  assert.match(markup, /name="isPublic"/);
  assert.match(markup, /checked=""/);
  assert.match(markup, />Public access</);
});
