import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import routes from '../web/routes.js';

type Node = { file: string; path?: string; index?: boolean; children?: Node[] };

/** Which route module answers a submission sent to a given path.
 *
 * React Router hands a submission to the deepest match that contributed a path
 * segment, so an index route never answers one and the layout above it does.
 * Resolving the same way here is the point: a test that guessed differently
 * would agree with the code while the browser disagreed.
 */
function submissionTargets(): Map<string, string> {
  const targets = new Map<string, string>([['/', 'root.tsx']]);
  const walk = (nodes: readonly Node[], prefix: string, answering: string) => {
    for (const node of nodes) {
      if (node.index) { targets.set(prefix || '/', answering); continue; }
      const full = `${prefix}/${node.path ?? ''}`;
      targets.set(full, node.file);
      if (node.children) walk(node.children, full, node.file);
    }
  };
  walk(routes as unknown as Node[], '', 'root.tsx');
  return targets;
}

function sourceFiles(): string[] {
  const roots = ['web', 'web/routes'];
  return roots.flatMap((dir) => readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
    .map((entry) => `${dir}/${entry.name}`));
}

const declaredTarget = /\baction\s*[:=]\s*["'](\/[^"']*)["']/g;

test('every form that names a route posts where something answers', () => {
  const targets = submissionTargets();
  const answers = new Map<string, boolean>();
  const hasAction = (file: string) => {
    const cached = answers.get(file);
    if (cached !== undefined) return cached;
    const source = readFileSync(`web/${file}`, 'utf8');
    const present = /export\s+(?:async\s+)?(?:function|const)\s+(?:client)?[Aa]ction\b/.test(source);
    answers.set(file, present);
    return present;
  };

  let checked = 0;
  for (const file of sourceFiles()) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(declaredTarget)) {
      // Only a POST needs a route to answer it; a GET form is navigation. The
      // method sits either side of the target in practice, so both are read.
      const nearby = source.slice(Math.max(0, match.index - 200), match.index + 200);
      if (!/method\s*[:=]\s*["']post["']/i.test(nearby)) continue;
      const path = match[1];
      const target = targets.get(path.replace(/\/$/, '') || '/');
      assert.ok(target, `${file} posts to ${path}, which is not a route`);
      assert.ok(hasAction(target),
        `${file} posts to ${path}, which ${target} does not answer — the browser replies 405`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, 'the scan found forms to check');
});

test('Appearance is saved by the section that shows it', () => {
  // The selector applies the choice locally before submitting, so a submission
  // that goes nowhere still looks like it worked. Nothing visible fails; the
  // preference simply never persists. Hence an assertion on the target rather
  // than on what the UI appears to do.
  const selector = readFileSync('web/appearance-selector.tsx', 'utf8');
  const submit = /fetcher\.submit\(([\s\S]*?)\);/.exec(selector);
  assert.ok(submit, 'the selector submits the choice');
  assert.doesNotMatch(submit[1], /\baction\b/, 'and names no route of its own');
  const section = readFileSync('web/routes/settings-appearance.tsx', 'utf8');
  assert.match(section, /export\s+async\s+function\s+clientAction/, 'the section it renders in answers');
});
