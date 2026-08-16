// node-launchpad-monitor-registry.svelte.ts
//
// NODE-OWNED LAUNCHPAD-MONITOR LIFETIME — the registry that keeps OUT TO LAUNCH
// driving a physical Launchpad when the CARD that bound it goes away.
//
// THE BUG THIS EXISTS FOR (#1728, from the #1583 audit's `pumps-leases` lens).
// `OutToLaunchCard` ran:
//
//     onDestroy(() => {
//       if (rafId !== null) cancelAnimationFrame(rafId);
//       if (isMonitorBound(id)) unbindMonitor(id);
//     });
//
// A card unmounts on COLLAPSE, on dock LRU eviction when a THIRD unrelated
// module is expanded, on ESC and on navigation. `outToLaunch` is
// `bespoke-surface` and is not a HEADLESS_MOUNT_LANE_TYPE, so under the default
// shell its card exists ONLY inside the dock full-view — which makes "collapse"
// the normal way to stop looking at it, and the normal way to kill the monitor.
//
// ⚠ THIS ROW REACHES HARDWARE, which is what separates it from its five
// siblings. MEASURED against the simulated device (the run that opened #1728's
// fix; the issue had only a code read):
//
//   mounted + bound → bound:true  programmer:true  79 LEDs lit, pad 11 = 127,127,127
//   after COLLAPSE  → bound:false programmer:false  0 LEDs lit, pad 11 = 0,0,0
//   after REMOUNT   → identical to post-collapse; the card comes back showing
//                     "Connect Launchpad" with NO port picker
//   after a 2nd collapse/expand cycle → still dead
//
// So all THREE halves fire, and none of them recovers:
//   1. THE CLAIM   — `monitors.delete(token)`, so `isOutputClaimed` goes false
//                    and LAUNCHPAD CONTROL is free to take the surface.
//   2. THE SURFACE — `unbindMonitor` writes every pad and surface CC to
//                    (0,0,0) and sends `encodeExitProgrammerMode()`. The
//                    performer sees a Launchpad go dark and drop back to Live
//                    mid-set. Recovering it needs Connect AND re-picking the
//                    port, which is two clicks inside a pane they just closed.
//   3. THE PUMP    — `tick()` was the ONLY consumer of `read(id,'grid9x9')`.
//                    The engine keeps producing the picture (the def is
//                    `pullExempt` precisely so the readback stays fresh with
//                    the card off-screen) and only the card delivered it. Fixing
//                    1+2 without 3 leaves the surface FROZEN on its last frame —
//                    the failure `node-recorder-registry` documents, and one
//                    that is invisible on a still source.
//
// ── WHY A REGISTRY, AND NOT #1742's ANSWER ─────────────────────────────────
// #1742 declined this shape for a MIDI setter, correctly: a setter is a pure
// function of (live node, param def), holds nothing, and so was resolved at
// DISPATCH time instead. Nothing there had a lifetime to key to a node.
//
// A monitor claim is the opposite on every count. It MUTATES the device (into
// programmer mode), it is EXCLUSIVE (one owner per physical surface — see
// `isOutputClaimed`), it accumulates diff state (`lastRgb`), and it is fed by a
// continuous 30 fps pump. There is no dispatch to resolve it at: the frames
// arrive forever, from a producer that never stops. That is a resource with a
// lifetime, and the lifetime is the NODE's.
//
// ── WHY THE CLAIM ITSELF STAYS IN launchpad-device ─────────────────────────
// #1729's separate-map reasoning applies. The `monitors` map is already
// node-keyed and already module-scope, and it lives beside the L/R clip-launcher
// units because `isOutputClaimed` has to arbitrate across BOTH consumers — one
// device layer spanning many nodes. Duplicating the claim here would mean two
// maps that can disagree about who owns a surface, which is precisely the bug
// the exclusivity rule exists to prevent. So this registry owns the NODE-scoped
// half (the pump, the engine handle, the graph-lifetime sweep) and delegates
// the DEVICE-scoped half. That division is the entire shape of the fix, because
// the claim was never the thing with the wrong lifetime — the CALLER was.
//
// ⚠ THE STRUCTURAL GUARD IS THE ABSENCE OF A CARD-LIFECYCLE METHOD. There is no
// `dispose(id)`, no `teardown(id)`, no `release(id)`, no `onCardUnmount(id)` —
// so a future `onDestroy` CANNOT re-introduce this defect by calling one,
// because `tsc` refuses the call before a test runs. The two legitimate
// releases are:
//   * `unbind(id)` — the USER's intent (the card's explicit "Unbind Launchpad"
//     button). Named for the user's action, never the component's lifecycle.
//   * `sweep(liveNodeIds)` — GRAPH lifetime, called from Canvas beside its five
//     sibling registries. A node deleted by ANY route (menu, lasso, undo, a
//     peer's CRDT delete, Clear, a patch load) releases the device here.
// The unit test asserts that distinction from both directions. A SOURCE-level
// guard backs it up (`node-launchpad-monitor-registry.test.ts`), because no
// runtime gate can see a card importing `unbindMonitor` straight from the
// device layer and calling it in a lifecycle hook — which is exactly what the
// pre-fix card did.
//
// WHAT THIS REGISTRY DELIBERATELY DOES NOT OWN: the on-card 9×9 PREVIEW canvas
// and the rAF that paints it. That really is card-lifetime — a canvas that is
// not in the DOM cannot be drawn to — and keeping it on the card is what makes
// the split legible. There is also no render-lease leg (cf. #1531): the def is
// `pullExempt`, so the engine already keeps drawing this node with no observer.
//
// HASH TRANSPARENCY: this lives under `lib/ui/**`. The WebGL attest basis takes
// from `lib/ui/modules` only cards whose source creates a WebGL context
// (OutToLaunchCard is 2D-canvas-only), so nothing here costs a GPU re-attest.

import type { EngineContext } from '$lib/audio/engine-context';
import type { VideoEngine } from '$lib/video/engine';
import {
  bindMonitor,
  unbindMonitor,
  isMonitorBound,
  monitorOutputId,
  setMonitorFrame,
} from '$lib/control/launchpad/launchpad-device.svelte';
import { monitorGridToLeds } from '$lib/control/launchpad/launchpad-sysex';
// The DEF is the one home for these numbers. `monitorGridToLeds` defaults gamma
// to 1 for an omitted option, but the module's declared default is 2.2 — so
// falling through to the helper's default would silently render a DIFFERENT
// picture than the card does. Import rather than re-type: a card that
// hand-typed a control's numbers instead of importing them from its def is the
// exact defect CLAUDE.md's "a CARD can silently disagree with its DEF" records.
import { OUT_TO_LAUNCH_DEFAULTS } from '$lib/video/modules/out-to-launch';

/** The engine accessor a card hands over at adopt time — the app's own
 *  `EngineContext`, not a private shape, so it cannot drift from the real one.
 *
 *  ⚠ It is the CONTEXT OBJECT, not a live engine. `useEngine()` is a
 *  `getContext` call and so is component-init-only, but the object it returns
 *  is a plain `{ get() }` getter over the engine Canvas owns — it stays valid
 *  after the card that read it has unmounted, and it re-resolves through an
 *  engine reboot. Both are exactly what this registry needs. */
export type EngineAccessor = EngineContext;

/** LED pushes per second. Lifted verbatim from the card's `PUSH_FPS`, so the
 *  move changes LIFETIME and nothing else — the wire rate the hardware sees is
 *  identical before and after. */
export const MONITOR_PUSH_FPS = 30;
const PUSH_INTERVAL_MS = 1000 / MONITOR_PUSH_FPS;

interface Entry {
  engine: EngineAccessor | null;
  /** rAF handle (browser) or timeout handle (node) for the pump. */
  frame: number | ReturnType<typeof setTimeout> | null;
  lastPush: number;
  /** Pump iterations that reached `setMonitorFrame`. The registry's own
   *  counter; reported only ALONGSIDE a device-side observable, never as the
   *  sole evidence that the surface is live. */
  framesPushed: number;
}

/** What a card renders from, and what the e2e probe reports. */
export interface LaunchpadMonitorView {
  bound: boolean;
  outputId: string | null;
}

class NodeLaunchpadMonitorRegistry {
  #entries = new Map<string, Entry>();
  /** Bumped on every membership/claim change so a Svelte card's `$derived`
   *  re-runs — including a card that mounted AFTER the bind was made, which is
   *  exactly the collapse/re-expand round trip this registry exists to
   *  survive. */
  #version = $state(0);

  /** Register the node and its engine accessor. Idempotent and
   *  NON-DESTRUCTIVE: a re-mounted card adopts the entry a previous mount left
   *  bound, which is the whole point. */
  adopt(id: string, engine: EngineAccessor): void {
    const existing = this.#entries.get(id);
    if (existing) {
      // A later mount re-pins the engine reference (a reboot swaps the
      // instance); it must never reset the binding or the pump.
      existing.engine = engine;
      return;
    }
    this.#entries.set(id, { engine, frame: null, lastPush: 0, framesPushed: 0 });
  }

  /** Reactive read for the card. Unknown ids read UNBOUND rather than throwing
   *  — a card can render one frame before its adopt effect runs. */
  view(id: string): LaunchpadMonitorView {
    void this.#version;
    return { bound: isMonitorBound(id), outputId: monitorOutputId(id) };
  }

  /** USER ACTION — the card's port picker. Claims the device and starts the
   *  node's pump. Returns false when the port is already owned by an L/R unit
   *  or another monitor (the one-owner-per-surface rule). */
  bind(id: string, outputId: string): boolean {
    const ok = bindMonitor(id, outputId);
    if (ok) {
      // A bind from a card that has not adopted yet (or after an engine
      // reboot) still gets an entry, so the pump can never be orphaned.
      if (!this.#entries.has(id)) this.#entries.set(id, { engine: null, frame: null, lastPush: 0, framesPushed: 0 });
      this.#startPump(id);
      this.#version++;
    }
    return ok;
  }

  /**
   * USER ACTION — the card's explicit "Unbind Launchpad" control.
   *
   * ⚠ NOT a lifecycle hook, and deliberately not named like one. A card unmount
   * must never reach this: that is the defect. See the header note on why the
   * absence of a `dispose(id)` is the structural guard.
   */
  unbind(id: string): void {
    unbindMonitor(id);
    this.#stopPump(id);
    this.#version++;
  }

  /**
   * GRAPH-LIFETIME teardown — the only place a device is released without the
   * user asking. Called from Canvas with the live node ids on every graph
   * change, exactly like its sibling registries.
   *
   * Releasing here is not optional politeness: a Launchpad left in programmer
   * mode with nothing driving it is unusable for control until a replug, so
   * "never unbind" would be its own hardware-facing bug.
   */
  sweep(liveNodeIds: Iterable<string>): void {
    const live = liveNodeIds instanceof Set ? liveNodeIds : new Set(liveNodeIds);
    let changed = false;
    for (const id of [...this.#entries.keys()]) {
      if (live.has(id)) continue;
      unbindMonitor(id);
      this.#stopPump(id);
      this.#entries.delete(id);
      changed = true;
    }
    if (changed) this.#version++;
  }

  /**
   * E2E probe — the NODE's own record.
   *
   * ⚠ `framesPushed` is this registry's opinion of its own pump and is NOT
   * sufficient evidence on its own: a push that never reached the wire looks
   * identical to one that did. The spec pairs it with the simulated device's
   * decoded LED state, which is the surface's own fact. Reported here so a
   * failure can say WHICH half broke — a stalled counter is a dead pump, a
   * moving counter with a frozen surface is a dropped claim.
   */
  probe(id: string): LaunchpadMonitorView & { hasEntry: boolean; pumping: boolean; framesPushed: number } {
    const e = this.#entries.get(id);
    return {
      ...this.view(id),
      hasEntry: !!e,
      pumping: !!e && e.frame !== null,
      framesPushed: e?.framesPushed ?? -1,
    };
  }

  /** Node ids this registry holds an entry for. Rows, never a count — a caller
   *  asserts PROPERTIES of the set. */
  trackedNodeIds(): string[] {
    void this.#version;
    return [...this.#entries.keys()].sort();
  }

  // ── The pump ─────────────────────────────────────────────────────────────
  // ONE frame: read the node's 9×9 readback and its live BRIGHT/GAMMA off the
  // ENGINE (never off a card's props — the card is the thing that may not
  // exist), map to LED colours, push. `setMonitorFrame` diffs internally, so a
  // still picture costs nothing on the wire.

  #pumpFrame(id: string): void {
    const e = this.#entries.get(id);
    if (!e) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - e.lastPush < PUSH_INTERVAL_MS) return;
    const ve = this.#videoEngine(e);
    if (!ve) return;
    const grid = ve.read(id, 'grid9x9') as Uint8Array | undefined;
    if (!grid) return;
    e.lastPush = now;
    const bright = ve.readParam(id, 'bright') ?? OUT_TO_LAUNCH_DEFAULTS.bright;
    const gamma = ve.readParam(id, 'gamma') ?? OUT_TO_LAUNCH_DEFAULTS.gamma;
    setMonitorFrame(id, { leds: monitorGridToLeds(grid, { bright, gamma }) });
    e.framesPushed++;
  }

  #videoEngine(e: Entry): VideoEngine | null {
    const eng = e.engine?.get();
    if (!eng) return null;
    try {
      return eng.getDomain<VideoEngine>('video') ?? null;
    } catch {
      return null;
    }
  }

  /** rAF in the browser; a ~16 ms timeout where rAF does not exist
   *  (vitest/node) so the unit suite can drive the loop by stubbing either
   *  scheduler. */
  #startPump(id: string): void {
    const e = this.#entries.get(id);
    if (!e || e.frame !== null) return;
    const tick = (): void => {
      const cur = this.#entries.get(id);
      if (!cur) return; // swept — the loop dies with the entry
      cur.frame = null;
      try {
        this.#pumpFrame(id);
      } catch {
        // A pump throw must not kill the loop: the next frame retries. (The old
        // card rAF died on throw AND on unmount; only the first was acceptable.)
      }
      if (this.#entries.has(id)) this.#schedule(id, tick);
    };
    this.#schedule(id, tick);
  }

  #schedule(id: string, tick: () => void): void {
    const e = this.#entries.get(id);
    if (!e) return;
    e.frame = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(tick) : setTimeout(tick, 16);
  }

  #stopPump(id: string): void {
    const e = this.#entries.get(id);
    if (!e || e.frame === null) return;
    if (typeof requestAnimationFrame !== 'undefined' && typeof e.frame === 'number') {
      cancelAnimationFrame(e.frame);
    } else {
      clearTimeout(e.frame as ReturnType<typeof setTimeout>);
    }
    e.frame = null;
  }
}

/** The singleton. Module scope = graph scope, which is the lifetime a bound
 *  Launchpad actually has. */
export const nodeLaunchpadMonitor = new NodeLaunchpadMonitorRegistry();
