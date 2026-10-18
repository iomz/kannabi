import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import neo4j from 'neo4j-driver';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';

const exec = promisify(execFile);
const suites = readdirSync('server').filter((file) => file.endsWith('.integration.test.ts')).sort();
const selected = process.argv.slice(2);
if (selected.some((file) => !suites.includes(file))) throw new Error('Pass integration test filenames from server/');
const queue = [...(selected.length ? selected : suites)];
// Suites share nothing: each has its own containers on random localhost ports,
// so they run side by side. Most of a suite's time is a container starting, so
// a few at once is what makes the whole run short; more than the machine's
// cores only slows each Neo4j's start.
const concurrency = Number(process.env.KANNABI_TEST_CONCURRENCY)
  || Math.max(1, Math.min(4, availableParallelism()));
const failed = [];

/** Run one suite against its own disposable containers, and print its output
 * in one piece when it ends so concurrent suites do not interleave. */
async function runSuite(testFile) {
  const startedAt = Date.now();
  const output = [];
  const log = (line) => output.push(line + '\n');
  const name = `kannabi-identity-test-${randomUUID()}`;
  const password = randomUUID();
  const image = process.env.NEO4J_TEST_IMAGE ?? 'neo4j:5-community';
  let started = false;
  let driver;
  let objectStarted = false;
  let storageEnv = {};
  try {
    log(`Starting disposable Neo4j (${image})`);
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
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...storageEnv, KANNABI_TEST_NEO4J_URI: uri, KANNABI_TEST_NEO4J_PASSWORD: password },
      });
      child.stdout.on('data', (chunk) => output.push(chunk));
      child.stderr.on('data', (chunk) => output.push(chunk));
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });
    if (code) failed.push(testFile);
  } catch (error) {
    failed.push(testFile);
    log(String(error?.stack ?? error));
  } finally {
    await driver?.close();
    // Removed rather than stopped: nothing in a disposable container is worth
    // a graceful shutdown, and Neo4j's takes most of the ten seconds `docker
    // stop` allows, once per suite.
    if (objectStarted) await exec('docker', ['rm', '-f', name + '-s3']).catch(() => {});
    if (started) {
      await exec('docker', ['rm', '-f', name]).catch(() => {});
      log('Disposable Neo4j removed; no user database was used.');
    }
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    process.stdout.write(`\n── ${testFile} (${seconds}s)\n`);
    for (const chunk of output) process.stdout.write(chunk);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  for (let next = queue.shift(); next; next = queue.shift()) await runSuite(next);
}));
if (failed.length) {
  console.error(`\nFailed: ${failed.join(', ')}`);
  process.exitCode = 1;
}
