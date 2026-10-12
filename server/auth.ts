import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { admin, bearer } from 'better-auth/plugins';
import { getAuthTables } from 'better-auth/db';
import { neo4jAdapter, buildSchemaStatements } from 'neo4j-better-auth';
import type { Driver } from 'neo4j-driver';
import { requiredText } from './identity.js';
import type { Mailer } from './mail.js';
import { hashPasswordResetIdentifier, invalidateOutstandingResetTokens, PasswordRecoveryStore, passwordResetPrefix,
  queuePasswordResetEmail } from './password-recovery.js';

export async function createAuth(driver: Driver, baseURL: string, secret: string, mailer?: Mailer) {
  if (secret.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  const origin = new URL(baseURL).origin;
  const recovery = new PasswordRecoveryStore(driver);
  const auth = betterAuth({
    baseURL: origin,
    secret,
    trustedOrigins: [origin],
    database: neo4jAdapter({ driver }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
      ...(mailer ? { sendResetPassword: async ({ user, token }: { user: { id: string; email: string }; token: string }) => {
        queuePasswordResetEmail(mailer, origin, user.email, token, await recovery.intentForUser(user.id));
      } } : {}),
      onPasswordReset: async ({ user }) => {
        await invalidateOutstandingResetTokens(recovery, user.id);
      },
    },
    user: {
      modelName: 'User',
      // Current password step-up is enforced by Kannabi's profile endpoint.
      // Revisit this immediate-update policy when email verification is introduced.
      changeEmail: { enabled: true, updateEmailWithoutVerification: true },
      additionalFields: {
        // Same User node as the domain model. Never accepted from signup input.
        key: { type: 'string', required: false, input: false, unique: true },
        // When an administrator approved this account, as an instant; absent
        // while it waits. Never accepted from signup input.
        approvedAt: { type: 'string', required: false, input: false },
      },
    },
    session: {
      modelName: 'AuthSession',
      cookieCache: { enabled: false },
      additionalFields: {
        // An API token is an ordinary session that a User named and kept. The
        // marker is what tells the two apart everywhere else; none of these is
        // ever accepted from request input.
        apiTokenLabel: { type: 'string', required: false, input: false },
        // Whether this credential may exercise its owner's administrator
        // authority. It is a ceiling on the credential, never a grant: the
        // owning User's current role is still what decides.
        apiTokenAdmin: { type: 'boolean', required: false, input: false },
      },
    },
    account: { modelName: 'AuthAccount' },
    verification: {
      modelName: 'AuthVerification',
      storeIdentifier: {
        default: 'plain',
        overrides: { [passwordResetPrefix]: { hash: hashPasswordResetIdentifier } },
      },
    },
    advanced: {
      database: { generateId: 'uuid' },
      // The Node entry point overwrites this header with the TCP peer address.
      ipAddress: { ipAddressHeaders: ['x-kannabi-client-ip'] },
    },
    databaseHooks: {
      user: { create: { before: async (user) => {
        let name: string;
        try { name = requiredText(user.name, 'name'); }
        catch { throw new APIError('BAD_REQUEST', { message: 'A valid name is required' }); }
        // A new account takes part at once only where the instance does not
        // require approval. Without readable settings it waits: an account
        // that should have waited and did not is the failure to avoid.
        const approvedAt = await approvalRequired(driver) ? undefined : new Date().toISOString();
        return { data: { ...user, name, key: randomUUID(), ...approvedAt ? { approvedAt } : {} } };
      } } },
    },
    rateLimit: { enabled: true },
    // Lets an API token authenticate as `Authorization: Bearer <token>` over
    // the same session machinery a browser cookie uses, so both credentials
    // converge on one User and one authorization path.
    plugins: [admin(), bearer()],
  });
  const tables = getAuthTables(auth.options);
  const session = driver.session();
  try {
    const statements = buildSchemaStatements(tables,
      (model) => tables[model].modelName ?? model,
      ({ model, field }) => tables[model].fields[field]?.fieldName ?? field);
    for (const statement of statements) await session.run(statement);
  } finally { await session.close(); }
  return auth;
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;

async function approvalRequired(driver: Driver): Promise<boolean> {
  const session = driver.session();
  try {
    const result = await session.run(`OPTIONAL MATCH (s:Settings {key: 'instance'})
      RETURN coalesce(s.requireApproval, true) AS required`);
    return result.records[0]?.get('required') !== false;
  } finally { await session.close(); }
}
