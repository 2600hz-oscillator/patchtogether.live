// packages/web/src/lib/livecode/diagnostics.test.ts
//
// Tests the standalone lintDoc() — the public testable surface of the
// CodeMirror linter wiring. The linter is invoked on every doc change
// in the editor and emits Diagnostic items at the offending text
// ranges. We assert the predicate matches the runtime's resolveCable
// so what the linter flags red == what the runtime would reject at
// Run-time.

import { describe, expect, it } from 'vitest';
import { lintDoc } from './diagnostics';
import type { ModuleNode } from '$lib/graph/types';

import '$lib/audio/modules';
import '$lib/video/modules';

function makeNode(id: string, type: string, name: string): ModuleNode {
  return {
    id,
    type: type as never,
    domain: 'audio',
    position: { x: 0, y: 0 },
    params: {},
    data: { name },
  };
}

function env(...nodes: ModuleNode[]) {
  const liveNodes: Record<string, ModuleNode> = {};
  for (const n of nodes) liveNodes[n.id] = n;
  return { liveNodes, liveEdges: {} };
}

describe('lintDoc', () => {
  it('returns no diagnostics for a valid patch() call', () => {
    const vco = makeNode('vco', 'analogVco', 'vco1');
    const sc = makeNode('sc', 'scope', 'scope1');
    const diags = lintDoc(`patch('vco1.sine', 'scope1.ch1');`, env(vco, sc));
    expect(diags).toHaveLength(0);
  });

  it('flags a patch() call when the source module is missing', () => {
    const sc = makeNode('sc', 'scope', 'scope1');
    const diags = lintDoc(`patch('ghost.sine', 'scope1.ch1');`, env(sc));
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe('error');
    expect(diags[0]!.message).toMatch(/ghost/);
  });

  it('flags a patch() call when the port is missing on the module', () => {
    const vco = makeNode('vco', 'analogVco', 'vco1');
    const sc = makeNode('sc', 'scope', 'scope1');
    const diags = lintDoc(`patch('vco1.notReal', 'scope1.ch1');`, env(vco, sc));
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toMatch(/has no port/i);
  });

  it('accepts both source-first AND destination-first arg order', () => {
    const vco = makeNode('vco', 'analogVco', 'vco1');
    const sc = makeNode('sc', 'scope', 'scope1');
    // source-first
    expect(lintDoc(`patch('vco1.sine', 'scope1.ch1');`, env(vco, sc))).toHaveLength(0);
    // destination-first
    expect(lintDoc(`patch('scope1.ch1', 'vco1.sine');`, env(vco, sc))).toHaveLength(0);
  });

  it('skips non-patch calls — does not flag spawn() / set()', () => {
    const vco = makeNode('vco', 'analogVco', 'vco1');
    const diags = lintDoc(
      `spawn('analogVco', 'vco2');\nset('vco1', 'tune', 12);`,
      env(vco),
    );
    expect(diags).toHaveLength(0);
  });

  it('emits one diagnostic per offending patch() call', () => {
    const vco = makeNode('vco', 'analogVco', 'vco1');
    const sc = makeNode('sc', 'scope', 'scope1');
    const src = [
      `patch('vco1.sine', 'scope1.ch1');`,         // ok
      `patch('vco1.notReal', 'scope1.ch1');`,      // bad
      `patch('vco1.sine', 'scope1.bogus');`,        // bad
    ].join('\n');
    const diags = lintDoc(src, env(vco, sc));
    expect(diags).toHaveLength(2);
  });

  it('lints unpatch() calls with the same predicate', () => {
    const vco = makeNode('vco', 'analogVco', 'vco1');
    const sc = makeNode('sc', 'scope', 'scope1');
    expect(lintDoc(`unpatch('vco1.notReal', 'scope1.ch1');`, env(vco, sc))).toHaveLength(1);
    expect(lintDoc(`unpatch('vco1.sine', 'scope1.ch1');`, env(vco, sc))).toHaveLength(0);
  });
});
