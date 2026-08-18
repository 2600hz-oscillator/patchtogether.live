// packages/web/src/lib/ui/audio-gate-stand-down.test.ts
//
// THE TWO SPELLINGS OF THE STAND-DOWN KEY MUST AGREE.
//
// The VRT lane opts out of the audio gate by seeding a localStorage key
// (`e2e/vrt/vrt-stand-down.ts`, delivered via `use.storageState`); the component
// reads that key at init (`AudioGate.svelte`). They are two string literals in two
// packages that nothing links.
//
// ⚠ A TYPO IS SILENT AND LOOKS LIKE SUCCESS. If the spellings diverge the flag
// simply never matches, the gate stays live in VRT, and the failure re-emerges as
// a phase shift in analyser-fed traces on two dock faceplates — which is exactly
// how long the original defect took to attribute. The runtime delivery check in
// `freezeAudioContext` catches it on CI; this catches it in the unit lane, in the
// second it takes to read two files.
//
// Both halves are read out of the SOURCE, so neither can be "fixed" here without
// the other moving.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '../../../../..');
const COMPONENT = resolve(REPO, 'packages/web/src/lib/ui/AudioGate.svelte');
const HARNESS = resolve(REPO, 'e2e/vrt/vrt-stand-down.ts');

/** The single-quoted string assigned to `name` in the given source. */
function literal(src: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*'([^']+)'`).exec(src);
  return m ? m[1]! : null;
}

describe('audio-gate stand-down key', () => {
  const component = readFileSync(COMPONENT, 'utf8');
  const harness = readFileSync(HARNESS, 'utf8');

  it('INSTRUMENT: both literals were actually found', () => {
    // Without this, a rename to either constant would make the equality below
    // compare null to null and pass — the check would survive its own subject.
    expect(literal(component, 'STAND_DOWN_KEY'), 'AudioGate.svelte: STAND_DOWN_KEY').not.toBeNull();
    expect(
      literal(harness, 'AUDIO_GATE_STAND_DOWN_KEY'),
      'e2e/vrt/vrt-stand-down.ts: AUDIO_GATE_STAND_DOWN_KEY',
    ).not.toBeNull();
  });

  it('the component reads the key the VRT config writes', () => {
    expect(
      literal(component, 'STAND_DOWN_KEY'),
      'the VRT lane seeds one key and AudioGate reads another, so the stand-down is ' +
        'inert: the gate stays live in every VRT scene and the next click after a ' +
        'freeze resumes the AudioContext, moving the phase of every analyser-fed trace.',
    ).toBe(literal(harness, 'AUDIO_GATE_STAND_DOWN_KEY'));
  });

  it('the component still gates the key on testHooksEnabled()', () => {
    // The safety half: without this the key would disable the audio gate for a
    // real user on production, where nothing else would ever raise it again.
    expect(
      /testHooksEnabled\(\)/.test(component),
      'AudioGate.svelte must ignore the stand-down key unless test hooks are enabled — ' +
        'otherwise a stray localStorage entry silently kills the gate in production.',
    ).toBe(true);
  });
});
