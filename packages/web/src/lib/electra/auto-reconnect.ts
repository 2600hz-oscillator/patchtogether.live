// packages/web/src/lib/electra/auto-reconnect.ts
//
// AUTO-RECONNECT (#2248) — re-flash the Electra One on patch load / F5 without
// a click, when (and only when) it is safe and wanted.
//
// WHY: `ElectraAutoconfig.run()` was invoked from exactly ONE place — the
// "Send to Electra" button — and every piece of the browser half of the wiring
// (the inbound CC/note dispatch, the FeedbackPump, the allocation table) lives
// in page-lifetime module state. A reload therefore dropped all of it, and the
// owner had to re-press the button after every F5 / patch load. The DEVICE was
// usually fine (the .epr survives in its flash), but the browser had forgotten
// how to talk to it.
//
// WHAT THIS IS: a small edge-triggered state machine, deliberately PURE over an
// injected dependency seam so the (load, device-connect) edge logic and the
// statechange debounce unit-test with no Web MIDI, no Svelte and no timers. The
// live wiring (broker singleton, patch store, the real flash) is
// `$lib/ui/modules/electra-auto-reconnect.ts`; Canvas.svelte calls
// `notifyPatchLoaded()` on each patch-load edge (mount hydration + the explicit
// zip / JSON load paths — the same per-load shape as the #2230 present
// restore).
//
// THE FLASH IS THE MANUAL PATH, NOT A SIBLING. `deps.flash` is
// `electraSendToDevice` — the exact seam the button and the ranked face cell
// fire — so the single-instance crosstalk guard (`liveAutoconfig`), the prime
// settle points, the outcome store and the display-only binding badges all
// behave identically however the flash was started. The only difference is that
// an automatic flash does not record an audition (nothing was pressed).
//
// SAFETY RAILS, in order:
//   1. NO ELECTRA CONTROL NODE → fully dormant. Not even a permission query,
//      so racks without the module keep the strict "page load never requests
//      Web-MIDI access" contract (midi.spec.ts regression).
//   2. PERMISSION NOT ALREADY GRANTED → dormant. We only proceed when the
//      Permissions API reports sysex-MIDI 'granted' (Chromium persists the
//      grant, so `requestMIDIAccess` then resolves silently). We NEVER cause a
//      permission prompt without a user gesture — the manual button remains
//      the granting path.
//   3. NO ELECTRA-NAMED PORT → armed but silent, until `onstatechange` says
//      one appeared (hot-plug). Name-strict on purpose: auto-flashing an
//      arbitrary MIDI interface that merely happens to be first in the port
//      list would be hostile; an oddly-named Electra still works via the
//      button (whose flash keeps the all-ports fallback).
//   4. EDGE-TRIGGERED, NEVER LEVEL-TRIGGERED: one flash per patch-load edge
//      and one per device absent→present edge. Nothing subscribes to the
//      graph, so graph churn (spawns, param writes, undo) can never re-flash;
//      a replug re-flashes once, which is exactly the re-wire a power-cycled
//      device needs.
//   5. Statechange bursts are DEBOUNCED (`settleMs`): the Electra surfaces ~6
//      USB ports one statechange at a time, and flashing before the CTRL port
//      exists would push the preset down the wrong pipe.
//
// MULTIPLAYER: everything here is local-client state — permission, port
// enumeration, and the flash itself write nothing to the shared doc, so a
// rack-mate with the same patch open never flashes (unless their own browser
// has its own granted permission and its own Electra, which is the correct
// behavior for their hardware).

/** Everything the reconnect machine needs from the app, injected for tests. */
export interface AutoReconnectDeps {
  /** Is Web MIDI callable at all in this browser? */
  midiSupported(): boolean;
  /** Current sysex-MIDI permission ('unknown' when unqueryable — treat as not
   *  granted; Firefox has no queryable 'midi' permission name). */
  permissionState(): Promise<'granted' | 'denied' | 'prompt' | 'unknown'>;
  /** Acquire (idempotent) sysex MIDI access — the broker's `connect()`. Only
   *  ever called after `permissionState()` said 'granted', so it never
   *  prompts. */
  connect(): Promise<boolean>;
  /** Is an Electra-NAMED port currently connected? (broker.hasElectraDevice) */
  devicePresent(): boolean;
  /** Subscribe to MIDI port statechange; returns the unsubscribe. */
  onStateChange(fn: () => void): () => void;
  /** The electraControl node to flash for, or null when the patch has none. */
  findElectraNodeId(): string | null;
  /** Run ONE flash — the same seam the manual button fires. */
  flash(nodeId: string): void;
  /** Timer seam (injectable for tests); defaults to global setTimeout. */
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearScheduled?: (t: ReturnType<typeof setTimeout>) => void;
  /** Statechange settle window; defaults to ELECTRA_RECONNECT_SETTLE_MS. */
  settleMs?: number;
}

/** How long after the LAST port statechange before we evaluate. The Electra
 *  enumerates three input + three output USB ports, each its own statechange
 *  event; flashing mid-burst can resolve the wrong CTRL port. 500ms is well
 *  above per-port enumeration spacing and well below "the user notices". */
export const ELECTRA_RECONNECT_SETTLE_MS = 500;

export class ElectraAutoReconnect {
  /** init() has been kicked off (it runs at most once). */
  private started = false;
  /** Permission granted + access connected + statechange listener installed. */
  private ready = false;
  private disposed = false;
  /** Last observed device presence — the edge detector's memory. */
  private present = false;
  /** A patch-load edge is waiting for a present device. */
  private pendingLoad = false;
  /** A device absent→present edge is waiting to flash. */
  private pendingDeviceEdge = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private unsub: (() => void) | null = null;

  constructor(private deps: AutoReconnectDeps) {}

  /**
   * A patch finished loading (page hydration, perf-zip, JSON import). Arms one
   * flash for when the device is (or becomes) present. Dormant — no permission
   * query, no access request — when the loaded patch has no electraControl.
   */
  notifyPatchLoaded(): void {
    if (this.disposed) return;
    if (!this.deps.findElectraNodeId()) return; // rail 1: no module → no MIDI side effects
    this.pendingLoad = true;
    if (!this.started) {
      this.started = true;
      void this.init();
      return;
    }
    // Through the SAME settle debounce as statechange (not a synchronous
    // evaluate): two load arms landing close together — e.g. a load path that
    // also nudges the mount latch — coalesce into ONE flash instead of
    // spamming the device twice with the same preset. While init() is still
    // in flight the timer's evaluate no-ops (not ready) and init's own tail
    // evaluate picks the armed edge up; a permission-less session stays
    // dormant for the page lifetime, which is rail 2.
    this.scheduleEvaluate();
  }

  /** One-time async bring-up. Quiet on every failure — auto-reconnect must
   *  never break boot; the manual button stays the fallback. */
  private async init(): Promise<void> {
    try {
      if (!this.deps.midiSupported()) return;
      if ((await this.deps.permissionState()) !== 'granted') return;
      if (!(await this.deps.connect())) return;
      if (this.disposed) return;
      // Baseline the presence WITHOUT treating it as an edge: the load edge
      // (pendingLoad) is what flashes an already-present device, so a later
      // re-init path could never double-flash.
      this.present = this.deps.devicePresent();
      this.unsub = this.deps.onStateChange(() => this.scheduleEvaluate());
      this.ready = true;
      this.evaluate();
    } catch {
      // Permissions API oddities / hostile navigator stubs — stay dormant.
    }
  }

  /** Debounced statechange → evaluate (rail 5). */
  private scheduleEvaluate(): void {
    if (this.disposed) return;
    const schedule = this.deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    const clear = this.deps.clearScheduled ?? ((t) => clearTimeout(t));
    if (this.settleTimer !== null) clear(this.settleTimer);
    this.settleTimer = schedule(() => {
      this.settleTimer = null;
      this.evaluate();
    }, this.deps.settleMs ?? ELECTRA_RECONNECT_SETTLE_MS);
  }

  /** The edge machine: flash exactly once per armed (load | device) edge, and
   *  only while a device is present and an electraControl node exists. */
  private evaluate(): void {
    if (this.disposed || !this.ready) return;
    const present = this.deps.devicePresent();
    if (present && !this.present) this.pendingDeviceEdge = true; // rail 4: rising edge only
    this.present = present;
    if (!present) return; // armed edges wait for the device
    if (!this.pendingLoad && !this.pendingDeviceEdge) return;
    // Consume the edges BEFORE flashing so a re-entrant statechange (the flash
    // itself never causes one, but a hostile fake might) cannot double-fire.
    this.pendingLoad = false;
    this.pendingDeviceEdge = false;
    const nodeId = this.deps.findElectraNodeId();
    if (!nodeId) return; // module deleted since the edge armed — drop it
    this.deps.flash(nodeId);
  }

  /** Tear down (tests / defensive). The live instance is page-lifetime. */
  stop(): void {
    this.disposed = true;
    if (this.settleTimer !== null) {
      (this.deps.clearScheduled ?? ((t) => clearTimeout(t)))(this.settleTimer);
      this.settleTimer = null;
    }
    this.unsub?.();
    this.unsub = null;
  }
}
