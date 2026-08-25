// packages/web/src/lib/ui/modules/vstBridge/vst-status-model.ts
//
// Every STRING the VST bridge body can produce, decided here rather than inline
// in the component — including the ones that are never painted.
//
// The reason is `es9-status-model.ts`'s and it carries over unchanged: an
// UNPAINTED string that is wrong is invisible to a VRT baseline and to a human
// reading one. Almost all of these end up on a `StatusLed`'s `detail` (its
// `aria-label` / `title`), which is where the resting-text ruling sends a
// measurement — speakable and assertable, never a text node. So they need a
// unit test, and a unit test needs them out of the markup.
//
// ⚠ THIS FILE IS WHERE THE CARD'S THREE DERIVED ROWS WENT. `VstBridgePanel`
// paints a seven-way state word, an in/out/load meter row with a round-trip
// time and a plugin latency, and a persisted-state size in KB. None of those
// may paint on a faceplate. All of them are still known, and each is composed
// into the sentence on the lamp that indicates it.
//
// ⚠ THE SNAPSHOT IS THE ONE SOURCE. Every function here takes a
// `VstOwnerSnapshot` and returns a string or a boolean — no reads, no clock, no
// component state — so the whole surface's text is a pure function of the
// bridge's published state and can be asserted without a browser.

import type { VstOwnerSnapshot } from '$lib/audio/vst/bridge-owner';

/** Is the bridge link actually up? The BRIDGE lamp's `lit`, decided beside the
 *  sentence that explains it. */
export function vstBridgeLit(snap: VstOwnerSnapshot): boolean {
  return snap.state === 'connected';
}

/**
 * The BRIDGE lamp's detail — the whole of what the card's status row said, in
 * one sentence on an `aria-label`.
 *
 * ⚠ THE NARROWING IS REAL AND IT IS STATED, exactly as on es9.
 * `VstConnectionState` has seven values and a lamp has two, so at REST the
 * plate shows the same dark lamp for "the helper is full" and "the helper is
 * not running" — two failures with genuinely different fixes. That is the
 * ruling's intended trade rather than an oversight, and it is mitigated rather
 * than solved: this sentence names the exact failure and `StatusLed` binds it
 * to BOTH `aria-label` and `title`, so hovering the lamp says which.
 *
 * ⚠ `busy` AND `evicted` ARE THE TWO THAT MOST NEED THE SENTENCE, because both
 * are RECOVERABLE by a gesture the plate already offers (CONNECT reclaims an
 * evicted instance — `bridge-owner.ts` names restart as the recovery path) and
 * a bare dark lamp would read as "broken" rather than "press the button".
 */
export function vstBridgeDetail(snap: VstOwnerSnapshot): string {
  if (!snap.supported) {
    return 'this browser context cannot host the bridge — it needs a Worker and a SharedArrayBuffer '
      + '(a cross-origin-isolated document)';
  }
  switch (snap.state) {
    case 'connected': {
      const who = snap.helper ? `${snap.helper.name} v${snap.helper.version}` : 'the vst-bridge helper';
      const rtt = snap.rtt === null ? '' : `, round trip ${snap.rtt.toFixed(1)} ms`;
      return `connected to ${who}${rtt}`;
    }
    case 'connecting':
      return 'opening the connection to the vst-bridge helper';
    case 'busy':
      return 'the helper is already hosting its maximum of 16 plugin instances — unmount one on '
        + 'another card, then press connect';
    case 'evicted':
      return "another tab took this card's plugin instance — press connect to reclaim it";
    case 'unsupported':
      return 'this browser context cannot host the bridge — it needs a Worker and a SharedArrayBuffer '
        + '(a cross-origin-isolated document)';
    case 'stopped':
    case 'idle':
      return 'the connection is down because it was stopped here — press connect to bring it back';
    default:
      return 'the vst-bridge helper did not answer on this machine — start it, then press connect';
  }
}

/** Is a plugin actually mounted and in the audio path? */
export function vstPluginLit(snap: VstOwnerSnapshot): boolean {
  return snap.mounted !== null;
}

/**
 * The PLUGIN lamp's detail — which plugin is live, and what it costs.
 *
 * ⚠ THIS IS WHERE THE `latency … smp` READOUT WENT, and it is the one number on
 * this surface a player might genuinely act on: an insert reporting thousands
 * of samples is a look-ahead limiter, and knowing that is the difference
 * between "the rack drifted" and "this plugin is doing its job".
 */
export function vstPluginDetail(snap: VstOwnerSnapshot): string {
  if (snap.mountError) {
    return `${snap.mountError.pluginId} failed to mount: ${snap.mountError.message}`;
  }
  if (!snap.mounted) {
    if (snap.state !== 'connected') return 'nothing is mounted — the bridge is not connected';
    return 'nothing is mounted — the bridge passes audio through bit-transparently';
  }
  const p = snap.mounted.plugin;
  return `${p.name} by ${p.manufacturer} is mounted, reporting ${snap.mounted.latencySamples} samples of latency`;
}

/**
 * The LOAD lamp — lit when the helper reports the plugin working hard enough to
 * be worth knowing about.
 *
 * ⚠ THE THRESHOLD IS A POLICY NUMBER OVER A DERIVED MEASUREMENT, not a
 * population count: it is "how hard is too hard", chosen once, and it moves
 * only if the answer to that question changes. 80 % is the point past which an
 * AU host has no headroom left for a buffer-size hiccup.
 */
export const VST_LOAD_WARN_PCT = 80;

export function vstLoadLit(snap: VstOwnerSnapshot): boolean {
  return snap.meters !== null && snap.meters.loadPct >= VST_LOAD_WARN_PCT;
}

/**
 * The LOAD lamp's detail — the whole of the card's meter row.
 *
 * ⚠ THIS IS WHERE `in … dB · out … dB · load …%` WENT, verbatim in content and
 * nowhere in pixels. The dB figures are a peak over the per-channel pairs, the
 * same reduction the card's `db()` helper did, restated here so the two
 * surfaces cannot disagree about what "in" means.
 */
export function vstLoadDetail(snap: VstOwnerSnapshot): string {
  const m = snap.meters;
  if (!m) return 'no meters yet — the helper reports levels once it is connected';
  return `input ${peakDb(m.inputRMS)}, output ${peakDb(m.outputRMS)}, plugin load ${m.loadPct.toFixed(0)}%`;
}

/** Peak of the per-channel dBFS pairs, worded rather than tabulated. The card's
 *  `db()` floors at −120 dBFS and prints `−∞`; this says the same thing in a
 *  sentence, because a lamp's detail is read aloud. */
function peakDb(v: number[] | undefined): string {
  if (!v || v.length === 0) return 'silent';
  const m = Math.max(...v);
  return m <= -120 ? 'silent' : `${m.toFixed(0)} dBFS`;
}

/**
 * The SAVED lamp — is this plugin's own state travelling with the patch?
 *
 * ⚠ IT IS A THREE-WAY FACT ON A TWO-WAY LAMP, and the dark half is the one that
 * matters: `stateBytes` present with NO `stateB64` means the blob was too large
 * to keep in the patch, so the plugin will come back as an EMPTY instance on
 * the next load. That is a real consequence a player must be able to discover,
 * which is why the sentence spells it out rather than reporting a size.
 */
export function vstSavedLit(persisted: { stateBytes?: number; stateB64?: string } | undefined): boolean {
  return persisted?.stateB64 !== undefined;
}

export function vstSavedDetail(
  persisted: { pluginId?: string; stateBytes?: number; stateB64?: string } | undefined,
): string {
  if (!persisted || persisted.stateBytes === undefined) {
    return 'nothing is saved in the patch yet — mount a plugin and its state is captured';
  }
  const kb = persisted.stateBytes / 1024;
  if (persisted.stateB64 === undefined) {
    return `this plugin's state is ${kb.toFixed(0)} KB, too large to keep in the patch — the plugin id `
      + 'travels but its settings do not, so save presets inside the plugin';
  }
  return `this plugin's state travels with the patch, ${kb.toFixed(1)} KB`;
}
