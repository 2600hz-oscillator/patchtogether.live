// packages/server/src/health.test.ts
//
// Pin down the /health JSON shape so an LLM agent + BetterStack monitor
// can rely on the contract:
//   { ok: true, status: "healthy", version, boot_id, uptime_s, mem_mb,
//     conns, ts }
// And the routing logic:
//   - GET /health → handled
//   - GET /health/ → handled
//   - GET /health?foo=bar → handled
//   - GET /metrics → not handled (returns false; caller falls through)
//   - POST /health → not handled (only GET)

import { describe, it, expect, vi } from 'vitest';
import { healthSnapshot, handleHealthRequest } from './health.js';

function makeRes() {
  const calls: Array<{ code?: number; headers?: Record<string, string>; body?: string }> = [];
  return {
    calls,
    writeHead(code: number, headers: Record<string, string>) {
      calls.push({ code, headers });
    },
    end(body: string) {
      calls.push({ body });
    },
  };
}

describe('healthSnapshot', () => {
  it('returns the expected schema', () => {
    const s = healthSnapshot(7);
    expect(s.ok).toBe(true);
    expect(s.status).toBe('healthy');
    expect(typeof s.version).toBe('string');
    expect(typeof s.boot_id).toBe('string');
    expect(typeof s.uptime_s).toBe('number');
    expect(s.uptime_s).toBeGreaterThanOrEqual(0);
    expect(typeof s.mem_mb).toBe('number');
    expect(s.mem_mb).toBeGreaterThan(0);
    expect(s.conns).toBe(7);
    expect(typeof s.ts).toBe('string');
  });
});

describe('handleHealthRequest', () => {
  it('handles GET /health and writes a JSON 200', () => {
    const res = makeRes();
    const handled = handleHealthRequest({ url: '/health', method: 'GET' }, res, 3);
    expect(handled).toBe(true);
    expect(res.calls[0].code).toBe(200);
    expect(res.calls[0].headers?.['content-type']).toMatch(/application\/json/);
    const body = JSON.parse(res.calls[1].body!);
    expect(body.ok).toBe(true);
    expect(body.conns).toBe(3);
  });

  it('handles GET /health/ (trailing slash)', () => {
    const res = makeRes();
    expect(handleHealthRequest({ url: '/health/', method: 'GET' }, res, 0)).toBe(true);
  });

  it('handles GET /health?foo=bar (with query)', () => {
    const res = makeRes();
    expect(handleHealthRequest({ url: '/health?foo=bar', method: 'GET' }, res, 0)).toBe(true);
  });

  it('does NOT handle other paths', () => {
    const res = makeRes();
    expect(handleHealthRequest({ url: '/metrics', method: 'GET' }, res, 0)).toBe(false);
    expect(handleHealthRequest({ url: '/', method: 'GET' }, res, 0)).toBe(false);
    expect(res.calls).toEqual([]);
  });

  it('does NOT handle POST', () => {
    const res = makeRes();
    expect(handleHealthRequest({ url: '/health', method: 'POST' }, res, 0)).toBe(false);
    expect(res.calls).toEqual([]);
  });

  it('defaults missing method to GET', () => {
    const res = makeRes();
    expect(handleHealthRequest({ url: '/health' }, res, 0)).toBe(true);
  });

  it('returns no-store cache header so monitors always see fresh state', () => {
    const res = makeRes();
    handleHealthRequest({ url: '/health', method: 'GET' }, res, 0);
    expect(res.calls[0].headers?.['cache-control']).toBe('no-store');
    void vi; // keep import used; linter
  });
});
