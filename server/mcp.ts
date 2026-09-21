import neo4j from 'neo4j-driver';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { IdentityStore } from './identity-store.js';
import { createMcpServer } from './mcp-tools.js';
import { principalAudienceResolver, systemAudienceResolver } from './mcp-principal.js';

/** Kannabi's domain MCP server, spoken over stdio.
 *
 * It talks to Neo4j directly through the same domain operations the web API
 * uses. It is not an HTTP client of Kannabi, it serves no network listener, and
 * it holds no session, cookie or API key: the host that launches this process
 * is the trust boundary.
 *
 * Read-only. It attaches to a database Kannabi has already opened rather than
 * installing constraints or migrating, so running it never modifies data.
 *
 * SECURITY: by default this process reads the entire Kannabi graph, including
 * Assets private to a Group and the Group structure itself, applying none of
 * Kannabi's per-User readability. Launch it that way only as a trusted local
 * process.
 *
 * `KANNABI_MCP_AUDIENCE=principal` instead answers only for an authenticated
 * User asserted by whatever launched this process, under that User's ordinary
 * Group access. That assertion is trusted because of the stdio process
 * boundary — the only writer to this stdin is the parent — so it is worth no
 * more than the decision to launch this process from a trusted gateway.
 *
 * stdout carries the MCP protocol. Every diagnostic goes to stderr.
 */
const password = process.env.NEO4J_PASSWORD;
if (!password) throw new Error('NEO4J_PASSWORD is required');

const driver = neo4j.driver(
  process.env.NEO4J_URI ?? 'bolt://127.0.0.1:7687',
  neo4j.auth.basic(process.env.NEO4J_USERNAME ?? 'neo4j', password),
  { connectionTimeout: 5000, connectionAcquisitionTimeout: 5000 },
);
const store = await IdentityStore.attachReadOnly(driver);

const modes = ['system', 'principal'] as const;
const mode = process.env.KANNABI_MCP_AUDIENCE ?? 'system';
if (!(modes as readonly string[]).includes(mode)) {
  throw new Error(`KANNABI_MCP_AUDIENCE must be one of ${modes.join(', ')}`);
}
const resolveAudience = mode === 'principal'
  ? principalAudienceResolver(store) : systemAudienceResolver();

const connection = await serveStdio(() => createMcpServer(store, resolveAudience), {
  onerror: (error) => console.error('Kannabi MCP error', error),
});
console.error(`Kannabi MCP server ready on stdio (read-only, ${mode === 'principal'
  ? 'per-User access for the asserted principal' : 'system-wide access'})`);

let closing = false;
/** Release the connection and the Neo4j pool exactly once, however the session
 * ended, then leave.
 *
 * The exit is explicit because the driver's pool keeps the event loop alive on
 * its own: without it this process outlives the host session that launched it
 * and holds Neo4j connections open for as long as the machine is up.
 */
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  try { await connection.close(); } catch { /* the transport may already be gone */ }
  try { await driver.close(); } catch { /* nothing left to release */ }
  process.exit(0);
}

// A host shuts a stdio server down by closing its stdin, not by signalling it.
for (const ending of ['end', 'close'] as const) {
  process.stdin.once(ending, () => { void shutdown(); });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void shutdown(); });
}
