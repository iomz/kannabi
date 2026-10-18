import type { Driver } from 'neo4j-driver';

/** For suites about something other than admission: let every account that
 * signs up take part at once, as an instance that does not require approval
 * does. Admission itself is proved in admission.integration.test.ts. */
export async function admitSignups(driver: Driver): Promise<void> {
  const session = driver.session();
  try { await session.run("MATCH (s:Settings {key: 'instance'}) SET s.requireApproval = false"); }
  finally { await session.close(); }
}
