import neo4j from 'neo4j-driver';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { IdentityStore } from './identity-store.js';
import { createMcpServer } from './mcp-tools.js';

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
 * SECURITY: this process reads the entire Kannabi graph, including Assets that
 * are private to a Group and the Group structure itself. It does not apply
 * Kannabi's per-User readability. Launch it only as a trusted local process,
 * and never expose it over a network.
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

const connection = await serveStdio(() => createMcpServer(store), {
  onerror: (error) => console.error('Kannabi MCP error', error),
});
console.error('Kannabi MCP server ready on stdio (read-only, system-wide access)');

/** Release the connection and the Neo4j pool exactly once, however the session
 * ended, then leave.
 *
 * The exit is explicit because the driver's pool keeps the event loop alive on
 * its own: without it this process outlives the host session that launched it
 * and holds Neo4j connections open for as long as the machine is up.
 */
let closing = false;
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
