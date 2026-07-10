// packages/server/src/r2-sigv4.ts
//
// Minimal AWS Signature V4 signer for Cloudflare R2's S3-compatible API.
//
// Why hand-rolled: the relay needs exactly two operations (PUT/GET of one
// blob per rack — see snapshot-store.ts); pulling @aws-sdk/client-s3 into
// the Fly image for that is ~10MB of dependency for ~80 lines of
// well-specified crypto. The algorithm is pinned by unit tests against
// AWS's own published SigV4 test vectors (see r2-sigv4.test.ts), so a
// regression here is caught without any network.
//
// Scope kept deliberately narrow (single-chunk requests, path-style URLs,
// no query signing beyond what R2 blob PUT/GET needs). R2 uses region
// "auto", service "s3".

import { createHash, createHmac } from 'node:crypto';

export interface SigV4Input {
  method: string;
  /** Absolute path, ALREADY URI-encoded the way it goes on the wire
   *  (S3-style canonical URIs are not double-encoded). */
  path: string;
  /** Canonical query string ('' when none). */
  query?: string;
  /** All headers to sign. MUST include host, x-amz-date (ISO basic
   *  yyyymmddThhmmssZ), and x-amz-content-sha256. */
  headers: Record<string, string>;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SigV4Result {
  /** Value for the Authorization header. */
  authorization: string;
  signature: string;
  /** Intermediate strings exposed for the test-vector pins. */
  canonicalRequest: string;
  stringToSign: string;
}

const sha256hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();

/** Hex sha256 of a request payload — the x-amz-content-sha256 value. */
export function payloadHash(body: Uint8Array | string): string {
  return sha256hex(typeof body === 'string' ? body : Buffer.from(body));
}

/** Hash of the empty payload (GET requests). */
export const EMPTY_PAYLOAD_HASH = sha256hex('');

export function signatureV4(input: SigV4Input): SigV4Result {
  // Canonical headers: lowercase names, trimmed values, sorted by name.
  const entries = Object.entries(input.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const normalized = new Map<string, string>(entries);
  const amzDate = normalized.get('x-amz-date');
  if (!amzDate) throw new Error('sigv4: headers must include x-amz-date');
  const contentSha = normalized.get('x-amz-content-sha256');
  if (!contentSha) throw new Error('sigv4: headers must include x-amz-content-sha256');
  const dateStamp = amzDate.slice(0, 8); // yyyymmdd
  const canonicalHeaders = entries.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = entries.map(([k]) => k).join(';');

  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path,
    input.query ?? '',
    canonicalHeaders,
    signedHeaders,
    contentSha,
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, signature, canonicalRequest, stringToSign };
}

/** ISO-basic timestamp (20260710T120000Z) for x-amz-date. */
export function amzTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
