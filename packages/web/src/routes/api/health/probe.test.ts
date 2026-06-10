import { describe, it, expect } from 'vitest';
import { wsToHealthUrl, probeHocuspocus } from './probe';

describe('wsToHealthUrl', () => {
  it('wss → https + /health', () => {
    expect(wsToHealthUrl('wss://patchtogether-server.fly.dev')).toBe(
      'https://patchtogether-server.fly.dev/health',
    );
  });
  it('ws → http + /health', () => {
    expect(wsToHealthUrl('ws://localhost:1235')).toBe('http://localhost:1235/health');
  });
  it('strips a trailing slash before appending /health', () => {
    expect(wsToHealthUrl('wss://host/')).toBe('https://host/health');
  });
});

describe('probeHocuspocus', () => {
  const okFetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;

  it('returns a degraded reason (not a throw) when the relay url is unset', async () => {
    const r = await probeHocuspocus(undefined);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unset/);
  });

  it('reports ok + ms on a 200', async () => {
    let t = 1000;
    const r = await probeHocuspocus('wss://host', {
      fetch: okFetch,
      now: () => (t += 5),
    });
    expect(r.ok).toBe(true);
    expect(r.ms).toBe(5);
    expect(r.error).toBeUndefined();
  });

  it('reports the status code on a non-200', async () => {
    const r = await probeHocuspocus('wss://host', {
      fetch: (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/503/);
  });

  it('reports the error message when fetch rejects', async () => {
    const r = await probeHocuspocus('wss://host', {
      fetch: (async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/connection refused/);
  });

  it('aborts after the timeout and never hangs', async () => {
    // A fetch that only settles when its abort signal fires.
    const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const r = await probeHocuspocus('wss://host', { fetch: hangingFetch, timeoutMs: 5 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/abort/i);
  });
});
