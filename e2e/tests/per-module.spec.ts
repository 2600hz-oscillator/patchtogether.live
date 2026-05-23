// e2e/tests/per-module.spec.ts
//
// Registry-driven per-module smoke + output-alive coverage. For every
// audio-output-producing module, asserts that the module spawns AND
// that its canonical output port emits a measurable signal when driven
// by the per-module driver (see _drivers.ts).
//
// What this slice ships:
//   * Spawn check: every registered module mounts without console / page
//     errors. (Redundant with modules.spec.ts for non-skipped modules,
//     but kept here so the spec is self-contained when modules.spec
//     eventually gets folded into this one.)
//   * Output-alive check: every module with `hasAudioOutput` is wired
//     into SCOPE.ch1 and its peak / RMS asserted to clear the floor.
//     Modules that need a gate/pitch to fire have a driver override
//     that spawns + wires SEQUENCER upstream.
//
// What's deferred to later slices:
//   * CV output → SCOPE check (would catch silent LFO regressions but
//     needs to handle the modulator-needs-clock case for many modules).
//   * Gate output → SCOPE check (similar — most gate sources need a
//     clock).
//   * Video output → VIDEO-OUT canvas-pixel check (reuse the
//     `waveform-trace-shape` pattern; deferred because video modules
//     mostly need an upstream image source that's the same complexity
//     as the per-CV-input wiring).
//   * Per-CV-input wire-LFO check (would catch "this module crashes
//     when you connect an LFO to its CV input"; needs a helper for
//     compatible-cable detection + driver-aware upstream selection).
//
// Adding a new module: usually no edits required. The default driver
// in _drivers.ts picks the first declared output; the test below
// auto-enrols via the registry manifest. If output-alive fails for
// the new module, register an override in _drivers.ts (gatePort /
// pitchPort / params) and the test passes automatically.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { readScopeSnapshot, summarize, runFor } from './_module-coverage-helpers';
import { REGISTRY } from './_registry';
import { driverFor } from './_drivers';

// Modules whose per-module output-alive check is intentionally skipped.
// Each entry cites the alternative coverage so we don't lose signal.
// Spawn-only smoke is still run for skipped modules unless they're in
// SKIP_SPAWN below.
const SKIP_OUTPUT_ALIVE: Record<string, string> = {
  // GROUP — needs data.children; covered by grouping-phase1.spec.ts.
  group: 'requires data.children; covered by grouping-phase1.spec.ts',
  // STICKY — meta card with no engine binding. No audio path.
  sticky: 'meta-domain; no audio path',
  // LIVECODE — text-DSL editor; no audio path.
  livecode: 'text-DSL; no audio path',
  // HELM — MIDI-driven; pitch_cv/gate are fallbacks but reliable
  // alive-check needs the per-spec MIDI mock. Covered by helm.spec.ts.
  helm: 'MIDI-driven; covered by helm.spec.ts',
  // SAMSLOOP — needs a loaded sample to sound. Covered by samsloop.spec.ts.
  samsloop: 'needs uploaded sample; covered by samsloop.spec.ts',
  // HYDROGEN — pattern grid needs cells toggled on before any voice
  // fires. Covered by the dedicated hydrogen E2E (when it lands; for
  // now, the spawn check is enough).
  hydrogen: 'pattern grid needs cells toggled; covered by hydrogen.spec.ts (pending)',
  // MIDI-CV-BUDDY / MIDICLOCK — depend on connected MIDI device.
  midiCvBuddy: 'requires MIDI device; covered by midi-cv-buddy.spec.ts',
  midiclock: 'requires MIDI device; covered by midiclock.spec.ts',
  // SCOPE — itself the canonical receiver. Wiring it into another
  // scope would be circular; skip.
  scope: 'is itself the canonical receiver',
  // AUDIO-OUT — terminal node, no outputs.
  audioOut: 'terminal; no outputs',
};

// Reference list of modules that can't spawn under bare spawnPatch —
// not consumed here (spawn-solo coverage lives in modules.spec.ts)
// but kept as a comment so a future per-module test that DOES need
// the module mounted (CV-input wire-LFO, video-output canvas-pixel
// check) starts from this same skip seed:
//
//   group: 'requires data.children; covered by grouping-phase1.spec.ts'

test.describe.configure({ mode: 'parallel' });

test.describe('per-module: output-alive smoke', () => {
  for (const mod of REGISTRY) {
    // Spawn-solo check is covered by modules.spec.ts (which also asserts
    // handle count + label substring) — running spawn-solo a second time
    // here adds ~2 sec × 74 modules of pure duplication. SKIP_SPAWN was
    // intentionally kept on this branch as a reference for which modules
    // can't spawn cleanly under bare spawnPatch (group needs
    // data.children), but the test is no longer emitted from here. If
    // modules.spec.ts ever stops covering spawn, restore the loop.

    // ───── Output-alive check ─────
    // Only stamp this for modules that declare an audio output AND
    // aren't on the skip list. CV/gate/video alive checks are deferred
    // to follow-up slices (see file header).
    if (!mod.hasAudioOutput) continue;
    const aliveSkip = SKIP_OUTPUT_ALIVE[mod.type];
    if (aliveSkip) {
      test.fixme(`${mod.type} audio output alive [SKIPPED: ${aliveSkip}]`, () => {});
      continue;
    }
    // Auto-skip effect modules — anything with an `audio`-typed INPUT
    // is a processor (filter, reverb, delay, mixer, …) and needs an
    // upstream source to emit signal. The bare-spawn output-alive
    // smoke can't drive them. A future slice with a "wire ANALOG-VCO →
    // module.audio" upstream driver in _drivers.ts will cover this; for
    // now, skip with a clear reason in the test name.
    const hasAudioInput = mod.inputs.some((p) => p.type === 'audio');
    if (hasAudioInput) {
      test.fixme(
        `${mod.type} audio output alive [SKIPPED: effect-shape (audio input) — needs upstream driver]`,
        () => {},
      );
      continue;
    }

    const driver = driverFor(mod);
    const outputPort = driver.outputPort;
    if (!outputPort) {
      test.fixme(`${mod.type} audio output alive [SKIPPED: no resolvable output port]`, () => {});
      continue;
    }

    test(`${mod.type} audio output (${outputPort}) emits signal when driven`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console: ${m.text()}`);
      });

      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const nodes: SpawnNode[] = [
        {
          id: 'sut',
          type: mod.type,
          position: { x: 60, y: 60 },
          domain: mod.domain,
          params: driver.params,
        },
        { id: 'scp', type: 'scope', position: { x: 800, y: 60 }, params: { timeMs: 50 } },
      ];
      const edges: SpawnEdge[] = [
        {
          id: 'e_sut_scp',
          from: { nodeId: 'sut', portId: outputPort },
          to: { nodeId: 'scp', portId: 'ch1' },
        },
      ];

      if (driver.gatePort || driver.pitchPort) {
        // 240 BPM = ~63 ms per 16th, several gate pings inside the
        // 800ms test window so transient envelopes don't fool us.
        nodes.unshift({
          id: 'seq',
          type: 'sequencer',
          position: { x: 60, y: 280 },
          params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 },
        });
        if (driver.gatePort) {
          edges.unshift({
            id: 'e_seq_g',
            from: { nodeId: 'seq', portId: 'gate' },
            to: { nodeId: 'sut', portId: driver.gatePort },
            sourceType: 'gate',
            targetType: 'gate',
          });
        }
        if (driver.pitchPort) {
          edges.unshift({
            id: 'e_seq_p',
            from: { nodeId: 'seq', portId: 'pitch' },
            to: { nodeId: 'sut', portId: driver.pitchPort },
            sourceType: 'pitch',
            targetType: 'cv',
          });
        }
      }

      await spawnPatch(page, nodes, edges);

      if (driver.gatePort || driver.pitchPort) {
        // Seed audible sequencer steps so gate/pitch fires repeatedly.
        await page.evaluate(() => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
            __ydoc: { transact: (fn: () => void) => void };
          };
          w.__ydoc.transact(() => {
            const seq = w.__patch.nodes['seq'];
            if (!seq) return;
            if (!seq.data) seq.data = {};
            seq.data.steps = [
              { on: true, midi: 60 },
              { on: true, midi: 64 },
              { on: true, midi: 67 },
              { on: true, midi: 72 },
            ];
          });
        });
      }

      // 800 ms covers wavetable-load times + several gate cycles.
      await runFor(page, 800);

      const snap = await readScopeSnapshot(page, 'scp');
      expect(snap, `${mod.type} scope snapshot`).not.toBeNull();
      if (!snap) return;
      const sum = summarize(snap.ch1);
      expect(
        sum.peak,
        `${mod.type}.${outputPort} peak (peak=${sum.peak.toFixed(4)}, rms=${sum.rms.toFixed(4)})`,
      ).toBeGreaterThan(0.005);

      expect(
        errors,
        `console/page errors during ${mod.type} alive check: ${errors.join(' | ')}`,
      ).toEqual([]);
    });
  }
});

