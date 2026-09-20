import { readFile } from 'node:fs/promises';
import neo4j from 'neo4j-driver';
import { S3Client, ListObjectsV2Command, DeleteObjectCommand, GetBucketVersioningCommand } from '@aws-sdk/client-s3';
import { IdentityStore } from '../../server/identity-store.js';
import { createAuth } from '../../server/auth.js';
import { S3Storage } from '../../server/storage.js';
import { MediaService } from '../../server/media.js';
import { demoAccounts, demoAllocations, demoAssets, demoGroups, demoNamespaces, demoOwners,
  demoPassword, evaluatorScopes } from './fixtures.js';
import { demoConfiguration, requireStoppedApp, requireUnversionedBucket, type DemoMode } from './safety.js';

export async function runDemo(mode: DemoMode, args: string[], env: NodeJS.ProcessEnv) {
  const config = demoConfiguration(mode, args, env);
  await requireStoppedApp(config.app, config.port);
  const driver = neo4j.driver(config.database.href, neo4j.auth.basic(env.NEO4J_USERNAME ?? 'neo4j', env.NEO4J_PASSWORD!),
    { connectionTimeout: 5000, connectionAcquisitionTimeout: 5000 });
  const s3 = new S3Client({ endpoint: config.storage.href, region: env.S3_REGION ?? 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY!, secretAccessKey: env.S3_SECRET_KEY! },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const bucket = env.S3_BUCKET!;
  const storage = new S3Storage(s3, bucket);
  const session = driver.session();
  try {
    await driver.verifyConnectivity();
    await storage.check();
    const versioning = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(30000) });
    requireUnversionedBucket(versioning.Status);
    const objects = async () => {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }), { abortSignal: AbortSignal.timeout(30000) });
        for (const object of page.Contents ?? []) { if (object.Key) keys.push(object.Key); }
        if (page.IsTruncated && (!page.NextContinuationToken || page.NextContinuationToken === token)) throw new Error('Storage returned an invalid continuation token');
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return keys;
    };
    const existingObjects = await objects();
    const existing = await session.run("MATCH (n) WHERE NOT (n:Settings AND n.key = 'instance') RETURN count(n) AS count");
    if (mode === 'seed' && (existing.records[0].get('count').toNumber() || existingObjects.length)) {
      throw new Error('Seed requires empty application data and media. Nothing changed. To replace local data, use demo:reset -- --yes.');
    }
    // Load every fixture before touching data, so missing images fail without partial setup.
    const photos = new Map<string, Buffer>();
    for (const asset of demoAssets()) {
      if (asset.photo && !photos.has(asset.photo)) photos.set(asset.photo, await readFile(new URL('./photos/' + asset.photo, import.meta.url)));
    }
    if (mode === 'reset') {
      // Remove bytes first. If any delete fails, do not clear Neo4j or reseed;
      // leave the application stopped and rerun reset after fixing storage.
      for (const key of existingObjects) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(30000) });
      if ((await objects()).length) throw new Error('Media bucket is not empty; keep the application stopped and retry reset');
      await session.executeWrite((tx) => tx.run('MATCH (n) DETACH DELETE n'));
    }
    const store = await IdentityStore.open(driver);
    const auth = await createAuth(driver, config.app.origin, env.BETTER_AUTH_SECRET!);
    const users: string[] = [];
    for (const account of demoAccounts) {
      const response = await auth.api.signUpEmail({ body: { ...account, password: demoPassword } });
      if (!response.user.key) throw new Error('Demo signup did not produce a domain User');
      users.push(response.user.key);
    }
    // Same explicit administrative grant as admin:grant; it grants no Asset access.
    await session.run("MATCH (u:User {key: $key}) SET u.role = 'admin' REMOVE u.isAdmin", { key: users[0] });
    await store.updateSettings(users[0], { requirePhoto: false, displayTimezone: 'UTC', themeId: 'default' });
    const groups = [];
    for (const [index, name] of demoGroups.entries()) groups.push(await store.createReportingGroup(name, users[[0, 1, 0, 2][index]]));
    await store.addGroupMember(users[1], groups[1].key, users[0]);
    await store.addGroupMember(users[0], groups[2].key, users[1]);
    const owners = [];
    for (const name of demoOwners) owners.push(await store.createOwner(name));
    for (const namespace of demoNamespaces) {
      await store.configureGiaiNamespace(users[[0, 1, 0, 2][namespace.group]], groups[namespace.group].key,
        { gcp: namespace.gcp, exclusions: namespace.exclusions });
    }
    const namespaces = await store.listGiaiNamespaces(users[0]);
    const allocateFrom = namespaces.find((namespace) => namespace.gcp === demoNamespaces[0].gcp)!;
    const media = new MediaService(store, storage);
    const reportedIds: string[] = [];
    for (const asset of demoAssets()) {
      const actorKey = users[asset.reporter];
      const reported = await media.report({ name: asset.name, identifiers: asset.identifiers,
        ...(asset.owner === null ? {} : { ownerKey: owners[asset.owner].key }) },
      { actorKey, groupKey: groups[asset.group].key },
      asset.photo ? new File([new Uint8Array(photos.get(asset.photo)!)], asset.photo, { type: 'image/png' }) : undefined);
      if (asset.isPublic) await store.updateAsset(reported.id, { isPublic: true }, actorKey);
      reportedIds.push(reported.id);
    }
    // Allocation order is fixed, so the issued references are deterministic.
    for (const index of demoAllocations) {
      await store.allocateGiai(reportedIds[index], users[demoAssets()[index].reporter], allocateFrom.key);
    }
    const page = await store.findAssets(users[0], { q: '', scope: 'all', limit: 1, after: null });
    for (const scope of ['all', 'mine', 'group', 'public'] as const) {
      if (page.scopes[scope] !== evaluatorScopes[scope]) throw new Error('Demo verification failed: unexpected access counts');
    }
    return { assets: demoAssets().length, photos: demoAssets().filter((asset) => asset.photo).length,
      namespaces: demoNamespaces.length, allocations: demoAllocations.length, scopes: page.scopes };
  } finally { await session.close(); await driver.close(); s3.destroy(); }
}
