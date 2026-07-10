// packages/server/src/r2-sigv4.test.ts
//
// Pins the SigV4 signer against AWS's OWN published test vectors
// ("Examples: Signature Calculations in AWS Signature Version 4",
// Amazon S3 API reference — the canonical GET-object and PUT-object
// examples with the documented example keypair). If these signatures
// match, the signer interoperates with any SigV4 verifier, including
// Cloudflare R2's S3-compatible endpoint — no network needed to prove it.

import { describe, expect, it } from 'vitest';

import {
  EMPTY_PAYLOAD_HASH,
  amzTimestamp,
  payloadHash,
  signatureV4,
} from './r2-sigv4.js';

// The documented AWS example credentials (public test fixtures, not secrets).
const ACCESS = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

describe('signatureV4 — AWS published test vectors', () => {
  it('matches the S3 GET-object example signature', () => {
    const result = signatureV4({
      method: 'GET',
      path: '/test.txt',
      query: '',
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        range: 'bytes=0-9',
        'x-amz-content-sha256': EMPTY_PAYLOAD_HASH,
        'x-amz-date': '20130524T000000Z',
      },
      region: 'us-east-1',
      service: 's3',
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
    });
    expect(result.signature).toBe(
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(result.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('matches the S3 PUT-object example signature (payload + extra headers)', () => {
    const body = 'Welcome to Amazon S3.';
    const contentSha = payloadHash(body);
    // Documented payload hash for the example body.
    expect(contentSha).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const result = signatureV4({
      method: 'PUT',
      path: '/test%24file.text', // "test$file.text", S3 canonical (single) encoding
      query: '',
      headers: {
        date: 'Fri, 24 May 2013 00:00:00 GMT',
        host: 'examplebucket.s3.amazonaws.com',
        'x-amz-content-sha256': contentSha,
        'x-amz-date': '20130524T000000Z',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      },
      region: 'us-east-1',
      service: 's3',
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
    });
    expect(result.signature).toBe(
      '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });

  it('sorts + lowercases signed headers and collapses value whitespace', () => {
    const result = signatureV4({
      method: 'GET',
      path: '/x',
      headers: {
        'X-Amz-Date': '20130524T000000Z',
        host: 'h',
        'x-amz-content-sha256': EMPTY_PAYLOAD_HASH,
        'B-Header': '  padded   value  ',
      },
      region: 'auto',
      service: 's3',
      accessKeyId: 'a',
      secretAccessKey: 's',
    });
    expect(result.canonicalRequest).toContain('b-header:padded value\n');
    expect(result.canonicalRequest).toContain('b-header;host;x-amz-content-sha256;x-amz-date');
  });

  it('refuses to sign without the mandatory x-amz-* headers', () => {
    expect(() =>
      signatureV4({
        method: 'GET',
        path: '/x',
        headers: { host: 'h', 'x-amz-content-sha256': EMPTY_PAYLOAD_HASH },
        region: 'auto',
        service: 's3',
        accessKeyId: 'a',
        secretAccessKey: 's',
      }),
    ).toThrow(/x-amz-date/);
    expect(() =>
      signatureV4({
        method: 'GET',
        path: '/x',
        headers: { host: 'h', 'x-amz-date': '20130524T000000Z' },
        region: 'auto',
        service: 's3',
        accessKeyId: 'a',
        secretAccessKey: 's',
      }),
    ).toThrow(/x-amz-content-sha256/);
  });
});

describe('amzTimestamp', () => {
  it('formats ISO-basic', () => {
    expect(amzTimestamp(new Date(Date.UTC(2013, 4, 24, 0, 0, 0)))).toBe('20130524T000000Z');
  });
});
