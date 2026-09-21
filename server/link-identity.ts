import neo4j from 'neo4j-driver';
import { IdentityStore } from './identity-store.js';

/** Bind an authenticated external identity to an existing Kannabi User.
 *
 * Provisioning lives here, outside every request path, because an assertion
 * from a gateway must never be able to create or claim an account. Until
 * someone with database access states whose identity this is, an
 * authenticated stranger resolves to nobody and reaches nothing.
 *
 * The issuer and the subject are the authority's own values. The subject is
 * whatever that authority calls the person, not their email address.
 */
const [email, issuer, subject] = process.argv.slice(2).map((value) => value?.trim());
if (!email || !issuer || !subject || !process.env.NEO4J_PASSWORD) {
  throw new Error('Usage: pnpm identity:link <existing-user-email> <issuer> <subject>; configure Neo4j first');
}
const driver = neo4j.driver(process.env.NEO4J_URI ?? 'bolt://127.0.0.1:7687',
  neo4j.auth.basic(process.env.NEO4J_USERNAME ?? 'neo4j', process.env.NEO4J_PASSWORD));
const session = driver.session();
try {
  const found = await session.executeRead((tx) => tx.run(
    'MATCH (u:User {email: $email}) WHERE u.accountDeletedAt IS NULL RETURN u.key AS key',
    { email: email.toLowerCase() }));
  if (found.records.length !== 1) throw new Error('Expected one active account with that email');
  const store = await IdentityStore.open(driver);
  const user = await store.linkExternalIdentity(found.records[0].get('key') as string, issuer, subject);
  console.log(`Linked ${issuer} subject ${subject} to ${user.name}. Asset access still requires Group membership.`);
} finally { await session.close(); await driver.close(); }
