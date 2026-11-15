import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

/** Run the unit tests the installed plugins keep beside their code.
 *
 * Core's tests run against a fixture plugin; a plugin's own tests run here,
 * against the plugins this checkout is built with. A checkout with no plugin
 * has none to run, and that is a pass rather than a missing file.
 */
const tests = existsSync('plugins')
  ? readdirSync('plugins', { recursive: true })
    .filter((file) => /\.test\.tsx?$/.test(file) && !file.endsWith('.integration.test.ts') && !file.includes('node_modules'))
    .map((file) => `plugins/${file}`).sort()
  : [];
if (tests.length === 0) {
  console.log('No plugin tests to run.');
} else {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
