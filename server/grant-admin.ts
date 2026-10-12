import neo4j from 'neo4j-driver';

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !process.env.NEO4J_PASSWORD) throw new Error('Usage: pnpm admin:grant <existing-user-email>; configure Neo4j first');
const driver = neo4j.driver(process.env.NEO4J_URI ?? 'bolt://127.0.0.1:7687',
  neo4j.auth.basic(process.env.NEO4J_USERNAME ?? 'neo4j', process.env.NEO4J_PASSWORD));
const session = driver.session();
try {
  const result = await session.executeWrite((tx) => tx.run(
    "MATCH (u:User {email: $email}) WHERE u.id IS NOT NULL SET u.role = 'admin', u.approvedAt = coalesce(u.approvedAt, $now) RETURN u.key",
    { email, now: new Date().toISOString() }));
  if (result.records.length !== 1) throw new Error('Expected one existing local account');
  console.log('Administrator access granted, and the account approved. Asset access still requires Group membership.');
} finally { await session.close(); await driver.close(); }
