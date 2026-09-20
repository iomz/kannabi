import { runDemo } from './run.js';
import { demoAccounts, demoPassword } from './fixtures.js';

const [mode, ...args] = process.argv.slice(2);
try {
  if (mode !== 'seed' && mode !== 'reset') throw new Error('Use pnpm demo:seed or pnpm demo:reset -- --yes');
  if (mode === 'reset') console.log('DESTRUCTIVE RESET: all local Neo4j application data and all objects in kannabi-photos will be deleted, then replaced with demo data.');
  const result = await runDemo(mode, args, process.env);
  console.log(`Created ${result.assets} synthetic Assets. Evaluator scopes: ${JSON.stringify(result.scopes)}.`);
  console.log(`Configured ${result.namespaces} GS1 Company Prefix namespaces and allocated ${result.allocations} GIAIs.`);
  console.log(`Reported over ${result.distinctDates} distinct dates, ${result.duplicatedDates} of them shared by several Assets.`);
  console.log('Development/demo only. Never expose these accounts publicly.');
  for (const account of demoAccounts) console.log(account.email + (account === demoAccounts[0] ? ' (system administrator)' : ''));
  console.log('Password for all demo accounts: ' + demoPassword);
  console.log('Start your local application and open ' + process.env.APP_URL);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Demo command failed');
  console.error('Do not start the application after a partial reset/seed failure. Fix the cause, then rerun demo:reset -- --yes.');
  process.exitCode = 1;
}
