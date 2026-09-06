// node-launchpad-monitor-registry.test.ts
//
// The NODE-owned Launchpad monitor (#1728) — the registry that keeps OUT TO
// LAUNCH driving a physical Launchpad after its card unmounts.
//
// Four things are asserted here, and the last two are the ones that actually
// stop the defect coming back:
//   1. the pump runs with NO card in existence, reading the picture off the
//      ENGINE (the card was the only consumer of `read(id,'grid9x9')`);
//   2. `sweep` really does release the device, so "survives collapse" cannot be
//      satisfied by simply never letting go — which would leave a Launchpad
//      stuck in programmer mode, unusable for control until a replug;
//   3. THE STRUCTURAL GUARD — there is no card-lifecycle method to call, so
//      `tsc` refuses the wrong call before any test runs;
//   4. THE SOURCE GUARD — no card may call the device layer's monitor mutators
//      directly. No runtime gate can see that: the pre-fix defect was one
//      import and one call inside `onDestroy`, which type-checks perfectly.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { MidiInputLike } from '$lib/audio/modules/midi-cv-buddy';
import type { MidiOutputLike } from '$lib/audio/modules/midi-out-buddy';
import {
  __test_setAccess,
  __test_resetLaunchpad,
  isMonitorBound,
  isOutputClaimed,
  type MidiFullAccessLike,
} from '$lib/control/launchpad/launchpad-device.svelte';
import { decodeSurfaceSysex } from '$lib/control/launchpad/launchpad-sysex';
import { OUT_TO_LAUNCH_DEFAULTS, OUT_TO_LAUNCH_GRID_BYTES } from '$lib/video/modules/out-to-launch';
import { nodeLaunchpadMonitor, MONITOR_PUSH_FPS } from './node-launchpad-monitor-registry.svelte';

// ── A device that records what it was actually told, decoded ───────────────

function fakeInput(id: string): MidiInputLike {
  return { id, name: 'LPMiniMK3 MIDI In', manufacturer: 'Focusrite - Novation', state: 'connected', onmidimessage: null } as unknown as MidiInputLike;
}

interface RecordingDevice {
  port: MidiOutputLike;
  programmer(): boolean;
  litIndices(): number[];
  lightingFrames(): number;
}

function recordingDevice(id: string): RecordingDevice {
  const leds = new Map<number, [number, number, number]>();
  let programmer = false;
  let frames = 0;
  const port = {
    id,
    name: 'LPMiniMK3 MIDI Out',
    manufacturer: 'Focusrite - Novation',
    state: 'connected',
    send(d: number[] | Uint8Array) {
      const cmd = decodeSurfaceSysex(d);
      if (!cmd) return;
      if (cmd.type === 'mode') {
        programmer = cmd.programmer;
        return;
      }
      frames++;
      for (const s of cmd.specs) leds.set(s.index, [s.r, s.g, s.b]);
    },
  } as unknown as MidiOutputLike;
  return {
    port,
    programmer: () => programmer,
    litIndices: () => [...leds.entries()].filter(([, [r, g, b]]) => r + g + b > 0).map(([i]) => i).sort((a, z) => a - z),
    lightingFrames: () => frames,
  };
}

function fakeAccess(outputs: MidiOutputLike[]): MidiFullAccessLike {
  return {
    inputs: new Map([['inA', fakeInput('inA')]]),
    outputs: new Map(outputs.map((p) => [p.id, p])),
    onstatechange: null,
  };
}

/** The mutable state a fake engine reports. Declared once so every call site
 *  widens `params` to a string index — svelte-check (stricter than vitest)
 *  rejects an inline object literal indexed by a plain `string`. */
interface FakeEngineState {
  grid: Uint8Array | undefined;
  params: Record<string, number>;
}

/** A minimal video engine: `read('grid9x9')` returns whatever the test set,
 *  `readParam` returns the node's live params. Handed to `adopt` through the
 *  SAME `{ get() }` context shape the card passes, so the registry cannot be
 *  passing a private convenience type in the test and a real one in prod. */
function fakeEngineCtx(state: FakeEngineState) {
  const video = {
    read: (_id: string, key: string) => (key === 'grid9x9' ? state.grid : undefined),
    readParam: (_id: string, p: string) => state.params[p],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { get: () => ({ getDomain: () => video }) } as any;
}

/** A 9×9 RGBA grid with one cell painted. */
function grid(col: number, row: number, rgb: [number, number, number]): Uint8Array {
  const g = new Uint8Array(OUT_TO_LAUNCH_GRID_BYTES);
  const p = (row * 9 + col) * 4;
  g[p] = rgb[0]; g[p + 1] = rgb[1]; g[p + 2] = rgb[2]; g[p + 3] = 255;
  return g;
}

/** Run the registry's pump N times. Under vitest's node environment there is no
 *  `requestAnimationFrame`, so the registry schedules on `setTimeout` — fake
 *  timers drive it deterministically, with no wall clock anywhere. */
async function pumpFrames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    // Advance past the 1/PUSH_FPS throttle AND the ~16 ms scheduler step, so
    // each iteration is one DELIVERED frame rather than one scheduler tick.
    await vi.advanceTimersByTimeAsync(Math.ceil(1000 / MONITOR_PUSH_FPS) + 20);
  }
}

const NODE = 'otl1';

// ⚠ RESTORE THE GLOBAL CLOCK. `packages/web/vitest.config.ts` runs the WHOLE
// unit suite in ONE process (`pool: 'forks'`, `singleFork: true`), so
// `vi.useFakeTimers()` patches a global that every LATER test file inherits.
// Leaving it installed took CI red on three unrelated files — the video CV/gate
// bridge, the reconciler and the Push 2 display — every one of them failing on
// `await new Promise((r) => setTimeout(r, n))`, which under fake timers never
// resolves and reports as `Test timed out`.
//
// It passed locally and only failed on CI because of vitest's SEQUENCER: with
// no `node_modules/.vite/vitest` timing cache (a fresh CI checkout) files are
// ordered by SIZE DESCENDING, and this file is larger than the three it broke,
// so it runs FIRST there. Locally the cache reorders by recorded duration and
// happened to put it last. The suite order is not a stable thing to rely on;
// restoring the clock is.
//
// File-level, not per-describe: the guard describes below install no timers of
// their own and would otherwise inherit whatever the last pump test left.
afterEach(() => {
  vi.useRealTimers();
});

describe('the pump belongs to the NODE, not the card', () => {
  beforeEach(() => {
    __test_resetLaunchpad();
    nodeLaunchpadMonitor.sweep([]);
    vi.useFakeTimers();
  });

  it('keeps pushing the ENGINE picture with no card anywhere in the story', async () => {
    const dev = recordingDevice('outA');
    __test_setAccess(fakeAccess([dev.port]));
    const state: FakeEngineState = { grid: grid(0, 0, [255, 255, 255]), params: { ...OUT_TO_LAUNCH_DEFAULTS } };

    // Adopt + bind, then never mention a card again. This IS the collapsed
    // state: the registry holds an engine accessor and nothing else.
    nodeLaunchpadMonitor.adopt(NODE, fakeEngineCtx(state));
    expect(nodeLaunchpadMonitor.bind(NODE, 'outA')).toBe(true);
    expect(dev.programmer(), 'bind put the device into programmer mode').toBe(true);

    await pumpFrames(2);
    expect(dev.litIndices(), 'the pump lit the bottom-left pad from the engine grid').toContain(11);
    const framesAfterFirst = dev.lightingFrames();
    expect(framesAfterFirst).toBeGreaterThan(0);

    // THE CAUSAL LEG: change the picture the ENGINE reports and the device
    // follows. A pump that had captured a stale reference would freeze here.
    state.grid = grid(8, 8, [255, 255, 255]); // the corner logo instead
    await pumpFrames(3);
    expect(dev.litIndices(), 'the surface followed the engine to the logo LED').toContain(99);
    expect(dev.lightingFrames()).toBeGreaterThan(framesAfterFirst);

    nodeLaunchpadMonitor.sweep([]);
  });

  it('reads BRIGHT/GAMMA live off the engine — a param change reaches the hardware', async () => {
    const dev = recordingDevice('outA');
    __test_setAccess(fakeAccess([dev.port]));
    const state: FakeEngineState = { grid: grid(0, 0, [255, 255, 255]), params: { bright: 1, gamma: 1 } };
    nodeLaunchpadMonitor.adopt(NODE, fakeEngineCtx(state));
    nodeLaunchpadMonitor.bind(NODE, 'outA');
    await pumpFrames(2);
    expect(dev.litIndices()).toContain(11);

    // BRIGHT 0 = off. The same grid, a different picture — so the pump is
    // re-reading the params every frame rather than latching the mount's.
    state.params.bright = 0;
    await pumpFrames(3);
    expect(dev.litIndices(), 'BRIGHT=0 blacked the surface out').toEqual([]);

    nodeLaunchpadMonitor.sweep([]);
  });

  it('a pump frame that throws does not kill the loop', async () => {
    const dev = recordingDevice('outA');
    __test_setAccess(fakeAccess([dev.port]));
    const state: FakeEngineState = { grid: grid(0, 0, [255, 255, 255]), params: { ...OUT_TO_LAUNCH_DEFAULTS } };
    let boom = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = {
      get: () => ({
        getDomain: () => {
          if (boom) throw new Error('engine hiccup');
          return { read: (_i: string, k: string) => (k === 'grid9x9' ? state.grid : undefined), readParam: (_i: string, p: string) => state.params[p] };
        },
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    nodeLaunchpadMonitor.adopt(NODE, ctx);
    nodeLaunchpadMonitor.bind(NODE, 'outA');
    await pumpFrames(2);
    expect(dev.litIndices()).toEqual([]);
    boom = false;
    await pumpFrames(2);
    expect(dev.litIndices(), 'the loop recovered once the engine came back').toContain(11);
    nodeLaunchpadMonitor.sweep([]);
  });
});

describe('the two legitimate releases, and only those', () => {
  beforeEach(() => {
    __test_resetLaunchpad();
    nodeLaunchpadMonitor.sweep([]);
    vi.useFakeTimers();
  });

  it('sweep releases a node that left the GRAPH — blanked, back to Live, claim gone', async () => {
    const dev = recordingDevice('outA');
    __test_setAccess(fakeAccess([dev.port]));
    const state: FakeEngineState = { grid: grid(0, 0, [255, 255, 255]), params: { ...OUT_TO_LAUNCH_DEFAULTS } };
    nodeLaunchpadMonitor.adopt(NODE, fakeEngineCtx(state));
    nodeLaunchpadMonitor.bind(NODE, 'outA');
    await pumpFrames(2);
    expect(dev.litIndices()).not.toEqual([]);

    // A graph that still contains the node changes NOTHING — sweep is keyed to
    // membership, so a re-render must not be a teardown.
    nodeLaunchpadMonitor.sweep([NODE, 'someOtherNode']);
    expect(isMonitorBound(NODE), 'a live node survives its own sweep').toBe(true);
    expect(dev.programmer()).toBe(true);

    nodeLaunchpadMonitor.sweep(['someOtherNode']);
    expect(isMonitorBound(NODE)).toBe(false);
    expect(isOutputClaimed('outA'), 'the surface is free for LAUNCHPAD CONTROL again').toBe(false);
    expect(dev.litIndices(), 'the released device was blanked').toEqual([]);
    expect(dev.programmer(), 'the released device went back to Live mode').toBe(false);

    // …and the pump stopped with it: no further frames reach a device we no
    // longer own. (A leaked loop would keep painting a surface another
    // consumer had since claimed.)
    const after = dev.lightingFrames();
    state.grid = grid(4, 4, [255, 255, 255]);
    await pumpFrames(4);
    expect(dev.lightingFrames(), 'a swept node stops pumping').toBe(after);
    expect(nodeLaunchpadMonitor.trackedNodeIds()).not.toContain(NODE);
  });

  it('unbind is the USER asking — same release, different reason', async () => {
    const dev = recordingDevice('outA');
    __test_setAccess(fakeAccess([dev.port]));
    nodeLaunchpadMonitor.adopt(NODE, fakeEngineCtx({ grid: grid(0, 0, [255, 255, 255]), params: { ...OUT_TO_LAUNCH_DEFAULTS } }));
    nodeLaunchpadMonitor.bind(NODE, 'outA');
    await pumpFrames(2);
    nodeLaunchpadMonitor.unbind(NODE);
    expect(isMonitorBound(NODE)).toBe(false);
    expect(dev.programmer()).toBe(false);
    // The ENTRY survives — the node is still in the graph, it just has no
    // device. A remounting card must be able to bind again without re-adopting.
    expect(nodeLaunchpadMonitor.trackedNodeIds()).toContain(NODE);
    nodeLaunchpadMonitor.sweep([]);
  });

  it('adopt is NON-DESTRUCTIVE: a re-mount does not disturb a live binding', async () => {
    const dev = recordingDevice('outA');
    __test_setAccess(fakeAccess([dev.port]));
    const state: FakeEngineState = { grid: grid(0, 0, [255, 255, 255]), params: { ...OUT_TO_LAUNCH_DEFAULTS } };
    nodeLaunchpadMonitor.adopt(NODE, fakeEngineCtx(state));
    nodeLaunchpadMonitor.bind(NODE, 'outA');
    await pumpFrames(2);
    const before = dev.lightingFrames();

    // The collapse/re-expand round trip: a SECOND adopt from a fresh mount.
    nodeLaunchpadMonitor.adopt(NODE, fakeEngineCtx(state));
    expect(nodeLaunchpadMonitor.view(NODE).bound, 'the re-mounted card sees MONITOR ACTIVE').toBe(true);
    expect(nodeLaunchpadMonitor.view(NODE).outputId).toBe('outA');
    expect(dev.programmer()).toBe(true);

    // …and exactly ONE pump is running. Two loops would double the wire rate.
    state.grid = grid(1, 1, [255, 255, 255]);
    await pumpFrames(1);
    expect(dev.lightingFrames(), 'one adopted mount, one pump').toBe(before + 1);
    nodeLaunchpadMonitor.sweep([]);
  });

  it('refuses a device another owner already holds (one owner per surface)', () => {
    const a = recordingDevice('outA');
    __test_setAccess(fakeAccess([a.port]));
    nodeLaunchpadMonitor.adopt('n1', fakeEngineCtx({ grid: undefined, params: {} }));
    nodeLaunchpadMonitor.adopt('n2', fakeEngineCtx({ grid: undefined, params: {} }));
    expect(nodeLaunchpadMonitor.bind('n1', 'outA')).toBe(true);
    expect(nodeLaunchpadMonitor.bind('n2', 'outA')).toBe(false);
    expect(nodeLaunchpadMonitor.view('n2').bound).toBe(false);
    nodeLaunchpadMonitor.sweep([]);
  });
});

describe('THE STRUCTURAL GUARD — there is no card-lifecycle teardown to call', () => {
  // The regression this file exists to prevent is a future `onDestroy` reaching
  // for a teardown method. The defence is that no such method EXISTS, so `tsc`
  // refuses the call before any test runs. This leg is a PERMANENT NEGATIVE
  // CONTROL: it fails the moment someone adds one back, which is exactly when a
  // human should be asked why.
  const LIFECYCLE_NAMES = ['dispose', 'destroy', 'teardown', 'unmount', 'onCardUnmount', 'release', 'disposeNode'];

  function surfaceOf(o: object): Set<string> {
    const names = new Set<string>();
    let proto: object | null = Object.getPrototypeOf(o);
    while (proto && proto !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(proto)) names.add(k);
      proto = Object.getPrototypeOf(proto);
    }
    return names;
  }

  it('exposes no method named for a component lifecycle event', () => {
    const surface = surfaceOf(nodeLaunchpadMonitor);
    expect(
      LIFECYCLE_NAMES.filter((n) => surface.has(n)),
      'a lifecycle-named method is an invitation to call it from onDestroy — which IS #1728. ' +
        'The two legitimate releases are unbind() (the user asked) and sweep() (the graph lost the node).',
    ).toEqual([]);
  });

  it('…and the guard is not vacuous: the SAME predicate sees the methods that ARE there', () => {
    const surface = surfaceOf(nodeLaunchpadMonitor);
    // Positive control on the same reflection the leg above uses, so an empty
    // offender list means "none of those names", not "the reflection found
    // nothing". These four are the registry's entire release/lifecycle surface.
    for (const present of ['adopt', 'bind', 'unbind', 'sweep']) {
      expect(surface.has(present), `${present} is on the surface`).toBe(true);
    }
  });
});

// ── THE SOURCE GUARD ───────────────────────────────────────────────────────
//
// No runtime gate can see the defect this replaces. It was ONE import and ONE
// call inside `onDestroy` — perfectly typed, perfectly linted, and invisible to
// every assertion that reads the graph, the def or the registry. So the guard
// has to read the SOURCE.
//
// IT MATCHES THE IMPORT, NOT THE CALL SITE, and that is the whole design. A
// `\bunbindMonitor\s*\(` scan is the obvious gate and it is WRONG: the first
// draft of this file went red on TWO false positives, both of them the prose in
// THIS fix's own explanatory comments quoting the defect it removed. The repair
// is not to strip comments with a pattern — that is the exact hazard CLAUDE.md
// names, where a `//`-stripping regex eats `'https://x'` — it is to key on a
// STRUCTURAL form. A component can only command the device if it imports the
// symbol, and prose does not accidentally take the shape of an import
// statement. A card is then free to describe the bug it no longer has.
//
// ⚠ WHAT THIS GATE CANNOT SEE, stated inside the gate:
//   * a dynamic `await import('…launchpad-device')`, or a re-export laundered
//     through a third module;
//   * a NON-card file (a store, a helper, an action) importing the mutators —
//     the scan is `lib/ui/**` `.svelte` only, because a card is where the
//     lifecycle hooks live and a plain helper has no `onDestroy`;
//   * whether the imported symbol is ever CALLED, or called from `onDestroy`.
//     It denies the IMPORT outright rather than locating the call, because
//     "import it, just don't call it there" is a distinction no reader can
//     hold and no static check here can enforce.
// It CAN see, exactly: a static import of a named device-layer monitor mutator
// (or a namespace import, which makes every member reachable) in any Svelte
// component under lib/ui.

const REPO_UI = new URL('../', import.meta.url).pathname; // packages/web/src/lib/ui/

/** The module a card would have to reach through. */
const DEVICE_MODULE_MARK = 'launchpad/launchpad-device';

/** The device-layer entry points that MUTATE a monitor claim or its surface.
 *  Reading state (`isMonitorBound`, `monitorOutputId`, `isOutputClaimed`,
 *  `enumerateLaunchpadPorts`, `connect`) is fine and is deliberately NOT listed
 *  — a card may ASK the device layer anything; it may not COMMAND it. */
const DEVICE_MUTATORS = ['unbindMonitor', 'bindMonitor', 'setMonitorFrame'] as const;
/** A namespace import makes every member reachable, so it is denied as a class
 *  rather than named per symbol. */
const NAMESPACE = 'import * as (whole module)';

/** DENY BY DEFAULT. Each exemption is a (file, symbol) pair with a `why`, and
 *  the `why` is REQUIRED BY THE TYPE so an undeclared exemption cannot compile.
 *  Anchored: an entry naming a file or symbol that is no longer imported there
 *  is RED, so a stale exemption cannot quietly widen the gate for whatever is
 *  written in that file next. */
interface MutatorExemption {
  /** Path relative to packages/web/src/lib/ui/. */
  file: string;
  symbol: (typeof DEVICE_MUTATORS)[number] | typeof NAMESPACE;
  why: string;
}
const ALLOWED_CARD_MUTATOR_IMPORTS: readonly MutatorExemption[] = [];

function svelteFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...svelteFilesUnder(p));
    else if (p.endsWith('.svelte')) out.push(p);
  }
  return out;
}

/** The predicate the gate and BOTH its controls call, so a green gate and a
 *  green control are statements about the same code. */
function deviceMutatorImports(source: string): string[] {
  const found = new Set<string>();
  const IMPORT = /import\s+([\s\S]{0,600}?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(IMPORT)) {
    const [, clause, specifier] = m;
    if (!specifier.includes(DEVICE_MODULE_MARK)) continue;
    if (/^\*\s+as\s+\w+$/.test(clause.trim())) {
      found.add(NAMESPACE);
      continue;
    }
    for (const mut of DEVICE_MUTATORS) {
      // A named specifier, with or without an `as` alias.
      if (new RegExp(`(^|[{,\\s])${mut}(\\s|,|}|$)`).test(clause)) found.add(mut);
    }
  }
  return [...found].sort();
}

describe('THE SOURCE GUARD — a surface may ask the device layer, never command it', () => {
  const files = svelteFilesUnder(REPO_UI);

  it('scanned a real, non-trivial set of components (else the gate is vacuous)', () => {
    // A bad path resolves to zero files and every assertion below passes for
    // free. Anchor on the ARTIFACT: the surface under test must be among them.
    // It used to be OutToLaunchCard.svelte; the monitor pump's surface is
    // OutToLaunchMonitorBody.svelte, which is what the shell mounts and what
    // the exemption list below is really about.
    expect(
      files.some((f) => f.endsWith('modules/outToLaunch/OutToLaunchMonitorBody.svelte')),
    ).toBe(true);
    expect(files.length).toBeGreaterThan(1);
  });

  it('no Svelte component imports a device-layer monitor MUTATOR', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(REPO_UI, f);
      for (const symbol of deviceMutatorImports(readFileSync(f, 'utf8'))) {
        if (ALLOWED_CARD_MUTATOR_IMPORTS.some((e) => e.file === rel && e.symbol === symbol)) continue;
        offenders.push(`${rel}: ${symbol}`);
      }
    }
    expect(
      offenders,
      'a card commanding the Launchpad directly is #1728: `onDestroy(() => unbindMonitor(id))` ' +
        'blanks all 81 LEDs, hands the surface back to Live and drops the claim — and a card ' +
        'unmounts on COLLAPSE / dock LRU eviction / ESC / navigation. Go through ' +
        'nodeLaunchpadMonitor, whose only releases are unbind() (the user asked) and ' +
        'sweep() (the graph lost the node).',
    ).toEqual([]);
  });

  it('every exemption still names something real — a stale entry is RED', () => {
    const stale = ALLOWED_CARD_MUTATOR_IMPORTS.filter(
      (e) => !deviceMutatorImports(readFileSync(join(REPO_UI, e.file), 'utf8')).includes(e.symbol),
    );
    expect(stale, 'exemptions naming an import that is not there any more').toEqual([]);
    for (const e of ALLOWED_CARD_MUTATOR_IMPORTS) {
      expect(e.why.length, `${e.file}:${e.symbol} needs a real reason`).toBeGreaterThan(40);
    }
  });

  it('PERMANENT POSITIVE CONTROL: the same predicate DOES flag the pre-fix card', () => {
    // Verbatim from OutToLaunchCard before this fix. If the scanner cannot see
    // this, the empty offender list above means "the matcher matches nothing",
    // not "no card commands the device" — and those look identical from a green
    // run, which is the whole reason this leg is permanent.
    const preFix = [
      `import {`,
      `  midiAvailable,`,
      `  bindMonitor,`,
      `  unbindMonitor,`,
      `  isMonitorBound,`,
      `  setMonitorFrame,`,
      `} from '$lib/control/launchpad/launchpad-device.svelte';`,
    ].join('\n');
    expect(deviceMutatorImports(preFix)).toEqual(['bindMonitor', 'setMonitorFrame', 'unbindMonitor']);
    // …and a namespace import, which would launder all three past a named check.
    expect(
      deviceMutatorImports(`import * as lp from '$lib/control/launchpad/launchpad-device.svelte';`),
    ).toEqual([NAMESPACE]);
  });

  it('PERMANENT NEGATIVE CONTROL: it does NOT flag reading, or prose', () => {
    // Direction two, and it is the one the first draft of this gate failed. A
    // matcher that fired on the word would red-flag every comment explaining
    // #1728 — including the ones in the card and Canvas that this fix ADDED —
    // and the honest response to that is a structural matcher, not deleting
    // the explanation.
    const readOnly = `import { isMonitorBound, monitorOutputId, isOutputClaimed } from '$lib/control/launchpad/launchpad-device.svelte';`;
    expect(deviceMutatorImports(readOnly)).toEqual([]);
    const prose = `// The card used to call unbindMonitor(id) here; setMonitorFrame(...) moved to the pump.`;
    expect(deviceMutatorImports(prose)).toEqual([]);
    // An unrelated module that happens to export a same-named symbol is out of
    // scope: the gate is about the DEVICE layer specifically.
    expect(deviceMutatorImports(`import { bindMonitor } from './something-else';`)).toEqual([]);
  });
});
