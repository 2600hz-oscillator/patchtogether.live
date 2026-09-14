// Postgres records the authority of every new save. R2 objects are immutable;
// a failed object write commits the same generation with inline database bytes.
// Generation-zero records and the old mutable R2 key are merged during migration.
import * as Y from "yjs";
import { randomUUID } from 'node:crypto';
import { loadSnapshotRecord, nextSnapshotGeneration, persistenceMode, storeSnapshotRecord,
  retiredSnapshotObjects, forgetRetiredSnapshotObject } from './db.js';
import { EMPTY_PAYLOAD_HASH, amzTimestamp, payloadHash, signatureV4 } from "./r2-sigv4.js";

export type SnapshotStoreMode = 'memory' | 'postgres' | 'r2';

export interface SnapshotStore {
  /** Which backend is live — surfaced on /health + /metrics (persist_mode). */
  mode(): SnapshotStoreMode;
  /** Latest persisted state for a rack, or null when none exists yet. */
  load(rackId: string): Promise<Uint8Array | null>;
  /** Persist the full state. NEVER throws. Returns whether the state is
   *  now durable — the journal-compaction gate (see db.ts storeSnapshotRecord). */
  store(rackId: string, state: Uint8Array): Promise<boolean>;
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Key prefix inside the bucket. Default 'rack-snapshots/'. */
  prefix: string;
  /** Endpoint override (tests / other S3-compatible stores). Defaults to
   *  https://<accountId>.r2.cloudflarestorage.com */
  endpoint: string;
}

/** Resolve R2 config from env. Returns null unless ALL required vars are
 *  present — partial config falls back to Postgres (never half-configured
 *  writes). One-time setup is documented in the PR / db/README.md. */
export function readR2Config(
  env: Record<string, string | undefined> = process.env,
): R2Config | null {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const bucket = env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    prefix: env.R2_PREFIX ?? 'rack-snapshots/',
    endpoint: env.R2_ENDPOINT ?? `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

/** Minimal fetch surface so tests can fake the network. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: Uint8Array;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

const R2_TIMEOUT_MS = 10_000;

// Order generation requests per rack across store instances. Pool connections
// can complete nextval queries out of order; that must not give an older
// captured document the newer generation. Object uploads still run concurrently.
const generationQueues = new Map<string, Promise<void>>();
function allocateGeneration(rackId: string): Promise<string> {
  const next = (generationQueues.get(rackId) ?? Promise.resolve()).then(nextSnapshotGeneration);
  const settled = next.then(() => {}, () => {});
  generationQueues.set(rackId, settled);
  void settled.then(() => {
    if (generationQueues.get(rackId) === settled) generationQueues.delete(rackId);
  });
  return next;
}

export interface SnapshotStoreDeps {
  env?: Record<string, string | undefined>;
  fetchFn?: FetchLike;
  now?: () => Date;
  log?: (level: 'log' | 'error', msg: string) => void;
}

export function createSnapshotStore(deps: SnapshotStoreDeps = {}): SnapshotStore {
  const env = deps.env ?? process.env;
  const fetchFn: FetchLike = deps.fetchFn ?? (fetch as unknown as FetchLike);
  const now = deps.now ?? (() => new Date());
  // eslint-disable-next-line no-console
  const log = deps.log ?? ((level: 'log' | 'error', msg: string) => console[level](msg));
  const r2 = readR2Config(env);

  async function r2Request(
    method: 'GET' | 'PUT' | 'DELETE',
    key: string,
    body?: Uint8Array,
  ): Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer> }> {
    if (!r2) throw new Error("Snapshot requires R2 configuration");
    const cfg = r2;
    const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${key}`);
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-date': amzTimestamp(now()),
      'x-amz-content-sha256': body ? payloadHash(body) : EMPTY_PAYLOAD_HASH,
    };
    const { authorization } = signatureV4({
      method,
      path: url.pathname,
      query: '',
      headers,
      region: 'auto',
      service: 's3',
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    });
    return fetchFn(url.toString(), {
      method,
      headers: { ...headers, authorization },
      body,
      signal: AbortSignal.timeout(R2_TIMEOUT_MS),
    });
  }

  async function readObject(key: string, allowMissing = false): Promise<Uint8Array | null> {
    const res = await r2Request('GET', key);
    if (res.status === 200) return new Uint8Array(await res.arrayBuffer());
    if (allowMissing && res.status === 404) return null;
    throw new Error(`Snapshot object unavailable: status=${res.status}`);
  }

  let lastCleanup = now().getTime();
  let cleanupRunning = false;
  async function cleanupRetiredObjects(): Promise<void> {
    if (!r2 || cleanupRunning || now().getTime() - lastCleanup < 60_000) return;
    cleanupRunning = true;
    lastCleanup = now().getTime();
    try {
      // Drain in bounded pages rather than capping throughput at one page per
      // minute. Only one request runs at a time; normal saves remain independent.
      for (;;) {
        const keys = await retiredSnapshotObjects();
        if (keys.length === 0) break;
        let failed = false;
        for (const key of keys) {
          const response = await r2Request('DELETE', key);
          if ((response.status >= 200 && response.status < 300) || response.status === 404) {
            await forgetRetiredSnapshotObject(key);
          } else failed = true;
        }
        if (failed) break; // Retry failed deletes on the next cleanup, without spinning.
      }
    } catch (err) {
      log('error', `[hocuspocus] retired snapshot cleanup deferred: ${(err as Error).message}`);
    } finally {
      cleanupRunning = false;
    }
  }

  return {
    mode: () => r2 ? 'r2' : persistenceMode(),

    async load(rackId) {
      const record = await loadSnapshotRecord(rackId);
      if (record?.r2Key) return readObject(record.r2Key);
      if (record && record.generation !== '0') return record.state;
      if (!r2) return record?.state ?? null;
      // Old deployments could save independently to either backend. Read both;
      // an unavailable backend is not evidence that its edits do not exist.
      const legacy = await readObject(`${r2.prefix}${encodeURIComponent(rackId)}`, true);
      if (legacy && record) return Y.mergeUpdates([legacy, record.state]);
      return legacy ?? record?.state ?? null;
    },

    async store(rackId, state) {
      try {
        const generation = await allocateGeneration(rackId);
        let r2Key: string | null = null;
        if (r2) {
          // The random suffix also protects immutable objects across database
          // restores or cloned branches whose sequences can share values.
          const key = `${r2.prefix}versions/${encodeURIComponent(rackId)}/${generation}-${randomUUID()}`;
          try {
            const res = await r2Request('PUT', key, state);
            if (res.status >= 200 && res.status < 300) r2Key = key;
            else log('error', `[hocuspocus] r2 store status=${res.status}: doc=${rackId}; saving inline`);
          } catch (err) {
            log('error', `[hocuspocus] r2 store failed: doc=${rackId}; saving inline: ${(err as Error).message}`);
          }
        }
        const durable = await storeSnapshotRecord(rackId, {
          generation, r2Key, state: r2Key ? new Uint8Array() : state,
        });
        if (durable) void cleanupRetiredObjects();
        return durable;
      } catch (err) {
        log('error', `[hocuspocus] snapshot save failed: doc=${rackId} ${(err as Error).message}`);
        return false;
      }
    },
  };
}
