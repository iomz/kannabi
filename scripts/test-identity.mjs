import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import neo4j from 'neo4j-driver';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { readdirSync } from 'node:fs';

const exec = promisify(execFile);
const suites = readdirSync('server').filter((file) => file.endsWith('.integration.test.ts')).sort();
const selected = process.argv.slice(2);
if (selected.some((file) => !suites.includes(file))) throw new Error('Pass integration test filenames from server/');
for (const testFile of selected.length ? selected : suites) {
  const name = `kannabi-identity-test-${randomUUID()}`;
  const password = randomUUID();
  const image = process.env.NEO4J_TEST_IMAGE ?? 'neo4j:5-community';
  let started = false;
  let driver;
  let objectStarted = false;
  let storageEnv = {};
  try {
    console.log(`Starting disposable Neo4j (${image})`);
    await exec('docker', ['run', '--rm', '-d', '--name', name,
      '-p', '127.0.0.1::7687', '-e', `NEO4J_AUTH=neo4j/${password}`,
      '-e', 'NEO4J_server_memory_heap_initial__size=256m',
      '-e', 'NEO4J_server_memory_heap_max__size=256m',
      '-e', 'NEO4J_server_memory_pagecache_size=128m', image]);
    started = true;
    const { stdout } = await exec('docker', ['port', name, '7687']);
    const uri = `bolt://${stdout.trim()}`;
    driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', password), {
      connectionTimeout: 1000, connectionAcquisitionTimeout: 2000,
    });
    const deadline = Date.now() + 90000;
    for (;;) {
      try { await driver.verifyConnectivity(); break; }
      catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    await driver.close();
    driver = undefined;
    // Suites that put bytes through the photo routes need object storage. The
    // rest do not, and starting a container for them would make every run slower
    // for nothing.
    const needsObjectStorage = ['media.integration.test.ts', 'demo.integration.test.ts',
      'corpus-load.integration.test.ts'];
    if (needsObjectStorage.includes(testFile)) {
      await exec('docker', ['run', '--rm', '-d', '--name', name + '-s3', '-p', '127.0.0.1::8080',
        '-e', 'ADMIN_PASSWORD=' + password, '-e', 'JWT=' + randomUUID() + randomUUID(),
        '-e', 'DEFAULT_ACCESS_KEY=' + name, '-e', 'DEFAULT_SECRET_KEY=' + password,
        '-e', 'DEFAULT_BUCKETS=kannabi-photos', '-e', 'ALLOW_ACCOUNT_CREATION=false',
        'ghcr.io/achtungsoftware/alarik:1.0.0-beta-16']);
      objectStarted = true;
      const { stdout: address } = await exec('docker', ['port', name + '-s3', '8080']);
      storageEnv = { S3_ENDPOINT: 'http://' + address.trim(), S3_BUCKET: 'kannabi-photos', S3_ACCESS_KEY: name, S3_SECRET_KEY: password, S3_REGION: 'us-east-1' };
      const s3 = new S3Client({ endpoint: storageEnv.S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true,
        credentials: { accessKeyId: name, secretAccessKey: password } });
      const storageDeadline = Date.now() + 90000;
      try {
        for (;;) {
          try { await s3.send(new HeadBucketCommand({ Bucket: storageEnv.S3_BUCKET }), { abortSignal: AbortSignal.timeout(2000) }); break; }
          catch (error) { if (Date.now() >= storageDeadline) throw error; await new Promise((r) => setTimeout(r, 1000)); }
        }
      } finally { s3.destroy(); }
    }
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--test', `server/${testFile}`], {
        stdio: 'inherit',
        env: { ...process.env, ...storageEnv, KANNABI_TEST_NEO4J_URI: uri, KANNABI_TEST_NEO4J_PASSWORD: password },
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });
    if (code) process.exitCode = code;
  } finally {
    await driver?.close();
    if (objectStarted) await exec('docker', ['stop', name + '-s3']);
    if (started) {
      await exec('docker', ['stop', name]);
      console.log('Disposable Neo4j stopped; no user database was used.');
    }
  }
}
