import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

/** Which modules are GS1's. Everything else under `server/` is Kannabi core,
 * apart from the composition file and the entry points that start a process. */
const gs1Modules = [
  'gs1', 'gs1-syntax', 'gs1-digital-link', 'gs1-prefixes', 'gs1-ledger', 'gs1-schemes',
  'reference-allocation', 'digital-link-resolution', 'digital-link-routes', 'surfaced-uri',
] as const;
const composed = ['composition', 'index', 'mcp', 'link-identity'];

/** The GS1 imports core still makes. This list is a ratchet and only shrinks:
 * each entry is GS1 behaviour that still lives in a core file and leaves with
 * it when GS1 moves behind the plugin contract. A new entry means core has
 * learned something about GS1 it did not know before, which is the thing this
 * test exists to stop. Remove an entry when its import goes; never add one. */
const remainingInCore: Readonly<Record<string, readonly string[]>> = {
  // Namespaces, class keys, issuance, the ledger and the GTIN conflict set.
  'identity-store': ['gs1', 'gs1-ledger', 'reference-allocation'],
  // GS1 routes, and the Digital Link and surfaced URIs of an Asset response.
  'inventory-api': ['gs1-digital-link', 'surfaced-uri'],
  // The GS1 tools and the GS1 wording of the lookup tool's input.
  'mcp-tools': ['gs1', 'gs1-ledger'],
};

/** The same ratchet for the web client, whose GS1 screens are not yet split
 * from the ones any deployment has. */
const remainingInWeb: Readonly<Record<string, readonly string[]>> = {
  'web/asset-identifiers.tsx': ['gs1'],
  'web/asset-row.tsx': ['gs1', 'surfaced-uri'],
  'web/asset-view.tsx': ['gs1-digital-link', 'surfaced-uri'],
  'web/inventory-controls.tsx': ['gs1'],
  'web/routes/digital-link.tsx': ['gs1-digital-link'],
  'web/routes/group-prefixes.tsx': ['reference-allocation'],
  'web/routes/home.tsx': ['gs1'],
  'web/routes/lookup.tsx': ['gs1'],
  'web/routes/report.tsx': ['surfaced-uri'],
};

const isGs1 = (name: string) => (gs1Modules as readonly string[]).includes(name);

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

/** The server modules a file imports, by bare name, wherever it sits. */
function serverImports(path: string, fromServer: boolean): string[] {
  const pattern = fromServer
    ? /from '\.\/([\w-]+)(?:\.js)?'/g
    : /from '(?:\.\.\/)+server\/([\w-]+)(?:\.js)?'/g;
  return [...new Set([...readFileSync(path, 'utf8').matchAll(pattern)].map((match) => match[1]))].sort();
}

test('core imports GS1 only where the ratchet still allows it', () => {
  const found: Record<string, string[]> = {};
  for (const path of sources('server')) {
    const name = relative('server', path).replace(/\.ts$/, '');
    if (isGs1(name) || composed.includes(name)) continue;
    const imports = serverImports(path, true);
    assert.ok(!imports.includes('composition'),
      `${name} imports the composition file; core takes what it needs as a value`);
    const gs1 = imports.filter(isGs1);
    if (gs1.length) found[name] = gs1;
  }
  assert.deepEqual(found, remainingInCore);
});

test('the web client imports GS1 only where the ratchet still allows it', () => {
  const found: Record<string, string[]> = {};
  for (const path of sources('web')) {
    const gs1 = serverImports(path, false).filter(isGs1);
    if (gs1.length) found[path] = gs1;
  }
  assert.deepEqual(found, remainingInWeb);
});

test('the modules core is built on name no GS1 module at all', () => {
  // The identifier model and everything that reads an Asset through it. These
  // are the modules this boundary was drawn for, so they are named outright
  // rather than left to be whatever the ratchet does not mention.
  for (const name of ['identifier', 'asset-lookup', 'asset-page', 'asset-representation', 'asset-audience',
    'asset-id', 'identity', 'settings', 'source-record', 'change-provenance']) {
    assert.deepEqual(serverImports(join('server', name + '.ts'), true).filter(isGs1), [], name);
  }
});
