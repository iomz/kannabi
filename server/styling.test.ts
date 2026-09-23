import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { builtInThemes } from '../web/themes/index.js';
import { themeStylesheet } from '../web/themes/variables.js';

const stylesheet = readFileSync('web/style.css', 'utf8');

const uiSources = () => ['web', 'web/routes'].flatMap((dir) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
    .map((entry) => [`${dir}/${entry.name}`, readFileSync(`${dir}/${entry.name}`, 'utf8')] as const));

test('the stylesheet holds the theme bridge and the document, and nothing narrower', () => {
  // The hand-written application stylesheet is gone rather than quarantined.
  assert.doesNotMatch(stylesheet, /@layer legacy/);
  assert.match(stylesheet, /@layer theme, base, components, utilities;/);
  // What is left is small enough to read in one sitting, which is the point.
  assert.ok(stylesheet.split('\n').length < 250, 'the stylesheet stays readable');
  // No screen-specific rules: every selector below is either the document or
  // the one Preflight repair every element needs.
  const base = /@layer base \{([\s\S]*?)\n\}/.exec(stylesheet)?.[1] ?? '';
  const selectors = [...base.matchAll(/^\s{2}([^\s{][^{]*)\{/gm)].map((match) => match[1].trim());
  assert.deepEqual(selectors.filter((name) => name.startsWith('.')), [],
    'nothing in the stylesheet is addressed by class');
});

test('colour is decided in one place and reaches the primitives from there', () => {
  // The palette is published under its own prefix so it can be mapped into
  // Tailwind's namespace rather than colliding with it.
  const bridge = /@theme inline \{([\s\S]*?)\n\}/.exec(stylesheet)?.[1] ?? '';
  assert.ok(bridge, 'the bridge exists');
  const mappings = [...bridge.matchAll(/(--color-[a-z-]+):\s*var\((--kannabi-[a-z-]+)\)/g)];
  assert.ok(mappings.length > 40, 'the whole palette is mapped, not a sample');
  // Every name the primitives ask for resolves to a palette token.
  for (const name of ['--color-background', '--color-foreground', '--color-card', '--color-primary',
    '--color-muted-foreground', '--color-border', '--color-input', '--color-ring',
    '--color-accent', '--color-destructive', '--color-sidebar', '--color-sidebar-accent']) {
    assert.ok(mappings.some(([, target]) => target === name), `${name} is mapped`);
  }
  // Every source is a palette token. A mapping that read from `--color-*`
  // would be reading from Tailwind's own namespace — the collision the prefix
  // exists to avoid — and could resolve to itself.
  const declared = [...bridge.matchAll(/^\s*(--[a-z-]+):/gm)].map((match) => match[1]);
  assert.deepEqual(declared.filter((name) => name.startsWith('--kannabi-')), [],
    'the bridge declares Tailwind names and reads Kannabi ones, never the reverse');
});

test('eight theme designs survive, in both colour schemes', () => {
  assert.equal(builtInThemes.length, 8);
  const css = themeStylesheet(builtInThemes);
  const canvases = new Set([...css.matchAll(/--kannabi-canvas:([^;]+)/g)].map((match) => match[1]));
  // Sixteen distinct canvases: the migration did not collapse the themes into
  // one light/dark pair.
  assert.equal(canvases.size, builtInThemes.length * 2);
});

test('the colour scheme follows the account preference, not a class', () => {
  // Kannabi resolves the scheme before the first paint and can preview the
  // other one, so `dark:` has to follow the attribute that carries it.
  assert.match(stylesheet, /@custom-variant dark \(&:where\(\[data-color-scheme="dark"\]/);
});

test('no component writes a colour of its own', () => {
  const literal = /(#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl|oklch)a?\()/;
  for (const [file, source] of uiSources()) {
    for (const [, value] of source.matchAll(/className="([^"]*)"/g)) {
      assert.doesNotMatch(value, literal, `${file} writes a colour instead of naming one`);
    }
  }
});

test('application navigation is chrome, not content', () => {
  // The migration gave every anchor the content-link colour, which turned the
  // sidebar cyan. An anchor a component rendered is that component and keeps
  // the colour its component decided; only a bare link into content is a link.
  assert.match(stylesheet, /a:not\(\[data-slot\]\) \{ color: var\(--kannabi-link\)/);
  assert.doesNotMatch(stylesheet, /^\s*a \{ color: var\(--kannabi-link\)/m);
});

test('an informational badge never wears the colour that means “do this”', () => {
  // Public, administrator and active-prefix are facts worth noticing, not
  // actions. They carry Kannabi's brand tint; `default` is the action colour
  // and the migration had reached for it.
  const badge = readFileSync('web/components/ui/badge.tsx', 'utf8');
  assert.match(badge, /brand: "bg-brand-soft text-brand-text"/);
  for (const [file, source] of uiSources()) {
    assert.doesNotMatch(source, /<Badge variant=\{[^}]*\? 'default'/,
      `${file} marks a fact with the action colour`);
  }
});
