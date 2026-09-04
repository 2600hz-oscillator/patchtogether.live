// present-link.ts
//
// RECEIVER-SIDE LINK HEALTH for the /present sink.
//
// THE PROBLEM IT SOLVES. The projector's only liveness signal used to live in
// the OPENER: `popupDriving` + `lastPullAt`, set immediately before the draw and
// outside its try/catch (present-window.ts). That is the right signal for the
// watchdog's job — reclaim the frame clock from a sink that stopped pulling —
// and it is decoupled from pixels BY CONSTRUCTION: a sink pulling perfectly
// while the opener paints pure black keeps it green forever. So the two states a
// performer most needs told apart, "my source is drawing" and "my source is
// gone", were indistinguishable, and the visible result of the second was a
// FROZEN LAST FRAME — bright, plausible, and wrong, on a wall.
//
// THE RULE THIS ENCODES: the receiver decides whether it is receiving. The
// opener now returns a per-frame `PresentPullStatus`; this turns the stream of
// those into a state the sink can SHOW and a test can READ.
//
// ⚠ EVERY THRESHOLD IS IN SINK FRAMES, NEVER MILLISECONDS. A projector's frame
// rate is whatever the venue's hardware says it is — 60 Hz on a monitor, 8 fps
// on the CI SwiftShader that runs this path in e2e. A wall-clock staleness
// budget would be a different assertion on every machine; a frame budget is the
// same one everywhere.
//
// Pure and dependency-free so the state machine is unit-testable without a DOM,
// a popup, or a GL context.

export type PresentLinkState =
  /** No painted frame has EVER arrived. The normal first moments of a cold
   *  engine, and — if it persists — a sink that was never wired up. */
  | 'waiting'
  /** Source pixels are arriving. */
  | 'live'
  /** The opener is still reachable but has stopped painting: a null/degenerate
   *  source, or a draw that throws every frame. The projector is BLACK. */
  | 'stalled'
  /** The opener's frame function is gone. Its window navigated, reloaded, or
   *  died. Nothing will drive this sink again. */
  | 'lost';

/** The subset of the opener's PresentPullStatus this monitor reads. Structural
 *  on purpose: an older opener returns `undefined` and the monitor still works
 *  off `sourcePresent` alone. */
export interface PresentPullSample {
  /** A callable `__presentFrame` was found on this tick and did not throw. */
  sourcePresent: boolean;
  /** Monotonic painted-frame count from the opener, when it reports one. */
  painted?: number;
  /** Monotonic swallowed-draw-error count from the opener. */
  errors?: number;
}

export interface PresentLinkMonitor {
  /** Feed exactly ONE sink frame; returns the state after it. */
  tick(sample: PresentPullSample): PresentLinkState;
  readonly state: PresentLinkState;
  /** Sink frames observed since mount — the denominator for "zero samples". */
  readonly ticks: number;
  /** Latest opener-reported counters (0 until an opener reports any). */
  readonly painted: number;
  readonly errors: number;
  /** Sink frames since `painted` last advanced. */
  readonly ticksSincePaint: number;
  readonly everPainted: boolean;
}

export interface PresentLinkThresholds {
  /**
   * Sink frames with no painted advance before a LIVE link is called stalled.
   *
   * Generous on purpose: a projector must not flash a scary banner because one
   * frame was slow. 120 frames is ~2 s at 60 Hz and ~15 s on the software
   * rasteriser CI uses — both comfortably longer than any hiccup this pipeline
   * legitimately produces, because when the link is healthy `painted` advances
   * on EVERY pull.
   */
  stallFrames: number;
  /**
   * Sink frames with no callable frame function before the link is called lost.
   *
   * Much smaller than stallFrames: the opener installs `__presentFrame` once
   * and never removes it except in `cleanup()`, so its absence is not a hiccup
   * — it means the opener tore down, navigated, or died.
   */
  lostFrames: number;
  /**
   * Sink frames a NEVER-painted armed sink waits before it says so.
   *
   * Long, because "the engine has not rendered yet" is a legitimate cold-start
   * state and this window has to clear a patch load. But not infinite: a sink
   * that is still black after this many of its own frames is a black projector,
   * which is the exact failure the old counter-based signal could not see.
   */
  coldFrames: number;
}

export const DEFAULT_PRESENT_LINK_THRESHOLDS: PresentLinkThresholds = {
  stallFrames: 120,
  lostFrames: 30,
  coldFrames: 600,
};

export interface CreatePresentLinkMonitorArgs {
  thresholds?: Partial<PresentLinkThresholds>;
  /**
   * ARMED sinks report link health; unarmed ones stay `waiting` forever.
   *
   * `/present` opened by hand in a browser tab has no opener and no session —
   * it is a black canvas by design, and telling its viewer their source is lost
   * would be a lie about a link that never existed. The page arms the monitor
   * only when it was opened BY something.
   */
  armed?: boolean;
}

export function createPresentLinkMonitor(
  args: CreatePresentLinkMonitorArgs = {},
): PresentLinkMonitor {
  const t = { ...DEFAULT_PRESENT_LINK_THRESHOLDS, ...(args.thresholds ?? {}) };
  const armed = args.armed !== false;

  let state: PresentLinkState = 'waiting';
  let ticks = 0;
  let painted = 0;
  let errors = 0;
  let ticksSincePaint = 0;
  let ticksSinceSource = 0;
  let everPainted = false;
  let everHadSource = false;

  return {
    tick(sample: PresentPullSample): PresentLinkState {
      ticks++;

      if (sample.sourcePresent) {
        everHadSource = true;
        ticksSinceSource = 0;
      } else {
        ticksSinceSource++;
      }

      // An opener that reports nothing (an older build) still drives the loop;
      // it simply cannot contribute paint evidence, so such a sink can only
      // ever reach 'live' via `sourcePresent` never disappearing. That is the
      // pre-existing behaviour, degraded honestly rather than faked.
      if (typeof sample.painted === 'number') {
        if (sample.painted > painted) {
          painted = sample.painted;
          everPainted = true;
          ticksSincePaint = 0;
        } else {
          ticksSincePaint++;
        }
      }
      if (typeof sample.errors === 'number') errors = sample.errors;

      state = derive();
      return state;
    },
    get state() {
      return state;
    },
    get ticks() {
      return ticks;
    },
    get painted() {
      return painted;
    },
    get errors() {
      return errors;
    },
    get ticksSincePaint() {
      return ticksSincePaint;
    },
    get everPainted() {
      return everPainted;
    },
  };

  function derive(): PresentLinkState {
    if (!armed) return 'waiting';
    // LOST outranks STALLED: no frame function is a strictly worse fact than a
    // frame function that paints nothing, and it names a different repair.
    if (everHadSource && ticksSinceSource >= t.lostFrames) return 'lost';
    if (everPainted) return ticksSincePaint >= t.stallFrames ? 'stalled' : 'live';
    // Never painted. A cold engine gets `coldFrames` of grace; past that the
    // projector is simply black and must say so.
    return ticks >= t.coldFrames ? 'stalled' : 'waiting';
  }
}
