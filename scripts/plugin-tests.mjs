import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { listed } from './plugins.mjs';

/** Run the unit tests the installed plugins keep beside their code.
 *
 * Core's tests run against a fixture plugin; a plugin's own tests run here.
 * Only the plugins the list names are tested: a directory under `plugins/`
 * that is not built in is not this checkout's to vouch for. Each plugin's
 * tests run on their own, under `plugins/<id>/test-composition.mjs` when the
 * plugin has one, so that what they see composed is that plugin and not
 * whatever else the deployment lists. A checkout with no plugin has none to
 * run, and that is a pass rather than a missing file.
 */
let failed = false;
let ran = 0;
for (const id of listed(process.cwd())) {
  const root = `plugins/${id}`;
  const tests = readdirSync(root, { recursive: true })
    .filter((file) => /\.test\.tsx?$/.test(file) && !file.endsWith('.integration.test.ts') && !file.includes('node_modules'))
    .map((file) => `${root}/${file}`).sort();
  if (tests.length === 0) continue;
  ran += 1;
  const hook = `./${root}/test-composition.mjs`;
  const result = spawnSync(process.execPath,
    ['--import', 'tsx', ...(existsSync(hook) ? ['--import', hook] : []), '--test', ...tests], { stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}
if (ran === 0) console.log('No plugin tests to run.');
process.exit(failed ? 1 : 0);
