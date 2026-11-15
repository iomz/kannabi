export type DemoMode = 'seed' | 'reset';
export function demoConfiguration(mode: DemoMode, args: string[], env: NodeJS.ProcessEnv) {
  const flags = args[0] === '--' ? args.slice(1) : args;
  if (mode === 'reset' && (flags.length !== 1 || flags[0] !== '--yes')) {
    throw new Error('RESET DELETES ALL application data and every object in the configured media bucket. Run pnpm demo:reset -- --yes to confirm.');
  }
  if (mode === 'seed' && flags.length) throw new Error('Usage: pnpm demo:seed');
  if (env.KANNABI_DEMO !== 'local' || (env.NODE_ENV && env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test')) {
    throw new Error('Demo commands require KANNABI_DEMO=local and a non-production development environment.');
  }
  function localURL(value: string | undefined, name: string, protocol: string) {
    if (!value) throw new Error(`${name} must be explicitly configured`);
    const url = new URL(value);
    if (url.protocol !== protocol || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
        || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
      throw new Error(`${name} must use ${protocol}// with a literal loopback address or localhost, no credentials or extra path`);
    }
    return url;
  }
  const app = localURL(env.APP_URL, 'APP_URL', 'http:');
  const database = localURL(env.NEO4J_URI, 'NEO4J_URI', 'bolt:');
  const storage = localURL(env.S3_ENDPOINT, 'S3_ENDPOINT', 'http:');
  if (env.S3_BUCKET !== 'kannabi-photos') throw new Error('Demo commands require the dedicated kannabi-photos bucket');
  for (const name of ['NEO4J_PASSWORD', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'BETTER_AUTH_SECRET']) {
    if (!env[name]) throw new Error(`${name} is required`);
  }
  if (env.BETTER_AUTH_SECRET!.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  return { app, database, storage, port };
}

export async function requireStoppedApp(app: URL, port: number) {
  // Refuse any responding HTTP service, not only a matching health response.
  // Operators must also stop other processes connected to these stores.
  for (const origin of new Set([app.origin, `http://127.0.0.1:${port}`])) {
    try {
      await fetch(origin + '/api/health', { redirect: 'error', signal: AbortSignal.timeout(2000) });
    } catch (error) {
      const cause = (error as { cause?: { code?: string; errors?: { code?: string }[] } }).cause;
      if (cause?.code === 'ECONNREFUSED' || (cause?.errors?.length && cause.errors.every((e) => e.code === 'ECONNREFUSED'))) continue;
      throw new Error('Could not prove the local application is stopped. Stop app/Vite and check APP_URL and PORT.');
    }
    throw new Error('Stop the local application/Vite before using demo commands (docker compose stop app, or stop pnpm dev).');
  }
}

export function requireUnversionedBucket(status: string | undefined) {
  if (status !== undefined) throw new Error('Demo commands require an unversioned media bucket; enabled or suspended versioning may retain hidden objects.');
}
