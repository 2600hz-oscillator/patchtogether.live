import { describe, it, expect } from 'vitest';
import { BUILD_INFO, formatBuildInfo, formatBuildTime, type BuildInfo } from './build-info';

describe('build-info', () => {
  it('BUILD_INFO uses the local dev fallbacks off a non-CI build', () => {
    // The two stamp vars are unset under vitest (no CI deploy env), so the
    // const collapses to the local-dev shape.
    expect(BUILD_INFO.version).toBe('dev');
    expect(BUILD_INFO.sha).toBe('local');
    expect(BUILD_INFO.time).toBe('');
    expect(formatBuildInfo()).toBe('local dev build');
  });

  it('formats a full CI stamp as a one-liner', () => {
    const info: BuildInfo = {
      version: '1.1.0-prod',
      sha: 'a1b2c3d',
      time: '2026-07-01T04:00:00Z',
    };
    expect(formatBuildInfo(info)).toBe('v1.1.0-prod · a1b2c3d · deployed 2026-07-01 04:00 UTC');
  });

  it('collapses to "local dev build" when sha is the local fallback', () => {
    expect(formatBuildInfo({ version: 'dev', sha: 'local', time: '' })).toBe('local dev build');
  });

  it('collapses to "local dev build" when the timestamp is missing', () => {
    expect(formatBuildInfo({ version: '1.1.0', sha: 'a1b2c3d', time: '' })).toBe('local dev build');
  });

  it('formats an ISO timestamp deterministically in UTC', () => {
    expect(formatBuildTime('2026-07-01T04:00:00Z')).toBe('2026-07-01 04:00 UTC');
    expect(formatBuildTime('2026-12-09T23:07:00Z')).toBe('2026-12-09 23:07 UTC');
  });

  it('returns empty for an empty or unparseable timestamp', () => {
    expect(formatBuildTime('')).toBe('');
    expect(formatBuildTime('not-a-date')).toBe('');
  });
});
