// packages/web/src/lib/ui/modules/es9/es9-status-model.ts
//
// Every STRING the ES-9 bridge body can produce, decided here rather than
// inline in the component — including the ones that are never painted.
//
// The reason is `MidiclockDeviceBody.svelte`'s and it is worth carrying: an
// UNPAINTED string that is wrong is invisible to a VRT baseline and to a human
// reading one. Almost all of these end up on a `StatusLed`'s `detail` (its
// `aria-label` / `title`), which is where the resting-text ruling sends a
// measurement — speakable and assertable, never a text node. So they need a
// unit test, and a unit test needs them out of the markup.
//
// ⚠ THIS FILE IS WHERE FOUR DELETED READOUTS WENT. The legacy card painted a
// state word, a device rate, a channel count, a round-trip time and an xrun
// pair as visible text. None of those may paint. All of them are still known,
// and each is composed into the sentence on the lamp that indicates it.

import type { Es9OwnerSnapshot } from '$lib/audio/es9/bridge-owner';
// ⚠ IMPORTED, NEVER RE-TYPED. The URL a failure sentence names must be the URL
// the worker actually dialled, or the hint sends the reader to the wrong port
// on a build that overrode it (`VITE_ES9_BRIDGE_URL`). `es9BridgeUrl()` is the
// one resolver; the same one-source rule the ranges obey.
import { es9BridgeUrl } from '$lib/audio/es9/bridge-client';

/** Is the hardware link actually up? The BRIDGE lamp's `lit`, decided beside
 *  the sentence that explains it. */
export function es9BridgeLit(snap: Es9OwnerSnapshot): boolean {
  return snap.state === 'connected';
}

/**
 * The BRIDGE lamp's detail — the whole of what the card's status row said, in
 * one sentence on an `aria-label`.
 *
 * ⚠ THE NARROWING IS REAL AND IT IS STATED. `Es9ConnectionState` has eight
 * values and a lamp has two, so at REST the plate shows the same dark lamp for
 * "the bridge is busy with another client" and "the ES-9 was unplugged" — two
 * failures with genuinely different fixes. That is the ruling's intended trade
 * rather than an oversight, and it is mitigated rather than solved: this
 * sentence names the exact failure and `StatusLed` binds it to BOTH
 * `aria-label` and `title`, so hovering the lamp says which.
 *
 * ⚠ A SECOND "FAULT" LAMP WAS CONSIDERED AND REFUSED. `lit={busy ||
 * device_lost}` would restore the two-way split, but it makes a plate whose
 * user simply pressed DISCONNECT read "bridge dark, fault lit" — a malfunction
 * where there is none. Two lamps that must be read together are a worse
 * surface than one lamp plus a hover. Recorded so the next reader does not
 * re-derive it.
 */
export function es9BridgeDetail(snap: Es9OwnerSnapshot): string {
  if (!snap.supported) {
    return 'this browser context cannot host the bridge — it needs a Worker and a SharedArrayBuffer '
      + '(a cross-origin-isolated document)';
  }
  switch (snap.state) {
    case 'connected': {
      const d = snap.device;
      if (!d) return 'connected to the es9-bridge app';
      const rate = `${d.rate / 1000} kHz`;
      const io = `${d.inputChannels}×${d.outputChannels}`;
      const rtt = snap.rtt === null ? '' : `, round trip ${snap.rtt.toFixed(1)} ms`;
      return `connected to ${d.name}, ${rate}, ${io}${rtt}`;
    }
    case 'connecting':
      return `connecting to the es9-bridge app on ${es9BridgeUrl()}`;
    case 'busy':
      return 'the es9-bridge app is busy — another client holds it; quit that client and connect again';
    case 'device_lost':
      return 'the ES-9 was unplugged — plug it back in, then connect';
    case 'unsupported':
      return 'this browser context has no SharedArrayBuffer, so the audio rings cannot be shared';
    case 'stopped':
    case 'idle':
      return 'the hardware link is down — press CONNECT to bring it up';
    default:
      return snap.detail && snap.detail.trim() !== ''
        ? `no es9-bridge app answered on ${es9BridgeUrl()} (${snap.detail})`
        : `no es9-bridge app answered on ${es9BridgeUrl()}`;
  }
}

/**
 * Has the stream failed to keep up? The XRUN lamp's `lit`.
 *
 * ⚠ IT COLLAPSES TWO OPPOSITE FAULTS ON PURPOSE. An UNDERRUN is the browser
 * failing to feed the hardware; an OVERRUN is the hardware outrunning the
 * browser. The card printed them as two numbers. One lamp is right anyway,
 * because the ACTION is the same in both cases — the stream is not keeping up —
 * and two adjacent amber lamps captioned UNDER and OVER is a diagnostic panel
 * rather than a faceplate. Which one it was is in the detail.
 */
export function es9XrunLit(snap: Es9OwnerSnapshot): boolean {
  const m = snap.meters;
  if (!m) return false;
  return m.underruns > 0 || m.overruns > 0;
}

/**
 * The XRUN lamp's detail.
 *
 * ⚠ THIS LAMP IS THE MOST CONSEQUENTIAL THING THE PROMOTION MOVED, and the
 * reason is that another module's SHIPPED faceplate already depends on it.
 * `CvBuddyStatusBody.svelte` says above its own LATE lamp: *"The ES-9 card
 * shows `xruns` (bridge starvation); this shows the clock pulses a LATE
 * scheduler tick could not place (main-thread stall). The two together are what
 * make 'the clock is unstable' diagnosable — they have opposite fixes."* So
 * deleting the xrun surface without replacing it would have broken a diagnosis
 * that lives on a different module's plate. Same primitive, same warn tone,
 * same count-in-the-detail discipline.
 *
 * A count may not paint, and a lamp that is PRESENT AND DARK says "healthy"
 * where the card's `0/0` had to argue that a zero must always render or
 * "healthy" and "not instrumented" would look identical.
 */
export function es9XrunDetail(snap: Es9OwnerSnapshot): string {
  const m = snap.meters;
  if (!m) {
    return snap.state === 'connected'
      ? 'no meters received from the bridge yet'
      : 'no hardware link, so nothing is being measured';
  }
  if (m.underruns === 0 && m.overruns === 0) {
    return 'the stream is keeping up — no underruns or overruns since the bridge came up';
  }
  const u = m.underruns === 1 ? '1 underrun' : `${m.underruns} underruns`;
  const o = m.overruns === 1 ? '1 overrun' : `${m.overruns} overruns`;
  return `${u}, ${o} since the bridge came up — the browser and the hardware are not keeping pace`;
}

/**
 * The CV-BUDDY lamp's detail: which physical out jacks a CV Buddy has claimed.
 *
 * ⚠ THIS IS WHY THE LAMP EXISTS AT ALL, AND IT IS NOT INFORMATIONAL. The card
 * called the line it replaces *"Purely informational"*, which undersells it:
 * `cv-buddy-es9-reconcile.ts` writes those jacks' `out{N}_class` params under
 * `CVBUDDY_JANITOR_ORIGIN` and its own header says *"while a CV Buddy is
 * present those jacks belong to it; set an ES-9 out-class by hand only when no
 * CV Buddy is in the rack."* A plate that renders eight identical, freely
 * editable OUT CLASS cells while a janitor silently reverts three of them is a
 * control that looks alive and is not. The signal has to survive the text.
 *
 * The union is also readable off the CV Buddy's OWN faceplate, where
 * `cvBuddySlotName` paints `JACKS 1-3` as permitted text — so what narrows is
 * only the at-a-glance union across several CV Buddies, which is small, real
 * and named.
 */
export function es9CvBuddyDetail(jacks: readonly string[]): string {
  if (jacks.length === 0) {
    return 'no CV Buddy in this rack — every out-jack class here is yours to set';
  }
  const list = jacks.join(', ');
  return `a CV Buddy is driving out jacks ${list} — the reconciler owns those jacks' class, `
    + 'so a change made here is reverted while it is in the rack';
}

/** Is any jack claimed? The CV-BUDDY lamp's `lit`. */
export function es9CvBuddyLit(jacks: readonly string[]): boolean {
  return jacks.length > 0;
}
