// packages/server/src/snapshot-store.ts
//
// Snapshot BLOB storage behind a small abstraction.
//
// Today a rack's Yjs snapshot is a bytea row in Postgres (db.ts). That's
// fine at kB scale, but the design ceiling is ~25MB per rack (stack study
// §8: "blobs in R2, pointer in Postgres") — megabyte blobs as hot-rewrite
// rows bloat Neon storage/WAL for no benefit. This module keeps ONE call
// site shape (load/store) and picks the backend at boot:
//
//   R2 configured (all four R2_* env vars) → blobs PUT/GET against
//     Cloudflare R2's S3-compatible API (SigV4, ./r2-sigv4.ts).
//     - load: R2 first; on 404 (or any R2 failure) fall back to the
//       Postgres row — this is the transparent migration path for racks
//       whose only snapshot predates R2 (including the template snapshot
//       the web app seeds at rack creation — rackspaces.ts writes
//       rack_snapshots directly and doesn't know about R2).
//     - store: R2 first; on ANY failure fall back to the Postgres store —
//       durability beats backend purity.
//   R2 absent → exactly the current behavior (db.ts: Postgres when
//     DATABASE_URL is set, else the in-memory dev/e2e map). Zero infra
//     required to run this code.
//
// The update JOURNAL (journal.ts) stays in Postgres in both modes: journal
// rows are small + short-lived (compacted every successful snapshot), the
// exact shape relational storage is good at.
//
// NOTE deliberately NOT done here: deleting the R2 blob when a rack is
// deleted (the web app's DELETE cascades the Postgres rows only). Orphaned
// blobs cost fractions of a cent and a follow-up lifecycle rule/cleanup
// job can reap them; wiring rack deletion through the relay is out of
// scope for the durability slice.

import { loadSnapshot, persistenceMode, storeSnapshot } from './db.js';
import { EMPTY_PAYLOAD_HASH, amzTimestamp, payloadHash, signatureV4 } from './r2-sigv4.js';

export type SnapshotStoreMode = 'memory' | 'postgres' | 'r2';

export interface SnapshotStore {
  /** Which backend is live — surfaced on /health + /metrics (persist_mode). */
  mode(): SnapshotStoreMode;
  /** Latest persisted state for a rack, or null when none exists yet. */
  load(rackId: string): Promise<Uint8Array | null>;
  /** Persist the full state. NEVER throws. Returns whether the state is
   *  now durable — the journal-compaction gate (see db.ts storeSnapshot). */
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

  if (!r2) {
    // No R2 → exactly the current db.ts behavior (postgres or memory).
    return {
      mode: () => persistenceMode(),
      load: (rackId) => loadSnapshot(rackId),
      store: (rackId, state) => storeSnapshot(rackId, state),
    };
  }

  // Narrowed alias — closures below outlive the null-check above, and TS
  // doesn't carry the narrowing into them.
  const cfg = r2;
  const keyFor = (rackId: string): string => `${cfg.prefix}${encodeURIComponent(rackId)}`;

  async function r2Request(
    method: 'GET' | 'PUT',
    rackId: string,
    body?: Uint8Array,
  ): Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer> }> {
    const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${keyFor(rackId)}`);
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

  return {
    mode: () => 'r2',

    async load(rackId) {
      try {
        const res = await r2Request('GET', rackId);
        if (res.status === 200) {
          return new Uint8Array(await res.arrayBuffer());
        }
        if (res.status !== 404) {
          log('error', `[hocuspocus] r2 load status=${res.status} (falling back to postgres): doc=${rackId}`);
        }
      } catch (err) {
        log('error', `[hocuspocus] r2 load FAILED (falling back to postgres): doc=${rackId} ${(err as Error).message}`);
      }
      // 404 (not migrated yet / fresh rack) or any R2 failure → the
      // Postgres row is the fallback truth. Covers web-seeded snapshots.
      return loadSnapshot(rackId);
    },

    async store(rackId, state) {
      try {
        const res = await r2Request('PUT', rackId, state);
        if (res.status >= 200 && res.status < 300) return true;
        log('error', `[hocuspocus] r2 store status=${res.status} (falling back to postgres): doc=${rackId}`);
      } catch (err) {
        log('error', `[hocuspocus] r2 store FAILED (falling back to postgres): doc=${rackId} ${(err as Error).message}`);
      }
      // Durability beats backend purity: a failed R2 write degrades to the
      // battle-tested Postgres path (which itself never throws).
      return storeSnapshot(rackId, state);
    },
  };
}
