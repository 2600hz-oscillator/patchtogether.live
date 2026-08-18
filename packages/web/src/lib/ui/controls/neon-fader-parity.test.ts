// packages/web/src/lib/ui/controls/neon-fader-parity.test.ts
//
// THE THROW'S BEHAVIOUR CONTRACT — every capability `NeonFader.svelte` must
// keep, named, with the reason it is there.
//
// ── WHAT THIS FILE USED TO BE, AND WHY IT CHANGED SHAPE (#1738 → #1794) ────
//
// It was a DIRECT SOURCE COMPARISON against `Fader.svelte`: the same roster
// asserted in BOTH files, so a new control that silently dropped the automation
// touch-suspend, or the MIDI badge, or the coalesced commit pump, went red. That
// was the right gate while a NEW control was being introduced beside a shipped
// one — nothing fails to compile when a copy omits a behaviour, and the old
// widget was right there to be compared against.
//
// #1794 migrated every call site onto `NeonFader` and DELETED `Fader.svelte`.
// A two-sided comparison with one side gone is not a weaker gate, it is a
// broken one, so the roster was re-founded rather than half-deleted:
//
//   * It is no longer a DESCRIPTION of what the other control had. Every row is
//     now a REQUIREMENT on the shipped control, which is why each carries a
//     `why` the TYPE demands — `tsc` refuses a row that does not argue for
//     itself, so "delete the row to make the suite pass" costs an explicit
//     removal of a stated reason rather than a silent line drop.
//   * The rows that were `ADDITIONS` (the keyboard gesture, `aria-valuetext`,
//     lost-pointer-capture recovery) are folded in as
//     ordinary requirements. They were only "additions" relative to a control
//     that no longer exists; against the shipped app they are simply things the
//     fader does, and the distinction was the last thing anchoring them to
//     `Fader.svelte`.
//
// ⚠ WHAT WAS LOST, PRECISELY. The old gate could catch a STALE ROW — one naming
// a behaviour neither control had — because a row had to match both files. A
// single-sided roster cannot do that by comparison. What replaces it is weaker
// in principle and adequate in practice: a stale row FAILS, loudly, against the
// only control there is, because every row is asserted as a requirement. The
// failure mode that survives is "someone deletes a row and the behaviour with
// it", and the `why` field plus the positive control below are what make that a
// deliberate act rather than an edit.
//
// ⚠ WHAT THIS GATE STRUCTURALLY CANNOT SEE:
//   * PIXELS and layout — it reads source. `face-mixmstrs-*.png` are the pixels.
//   * SEMANTICS. It proves `NeonFader` calls `notifyAutomationTouch`; it cannot
//     prove it calls it at the right moment. The behaviour-level proof is
//     `faces-parity.spec.ts` and `workflow-drawer-face.spec.ts` (drag → graph,
//     right-click → MIDI learn).
//   * Anything a row does not name. The roster is the gate's whole subject, so
//     a capability nobody wrote a row for is unprotected — that is the blind
//     spot, and it is why a row is added when a behaviour is added.

import { describe, expect, it } from 'vitest';

const SRC = import.meta.glob('./*.svelte', { eager: true, query: '?raw', import: 'default' }) as Record<
  string,
  string
>;
const NEON = SRC['./NeonFader.svelte'] ?? '';

/**
 * A behaviour the shipped throw must have. `why` is REQUIRED: a probe with no
 * argument is a diff, and the one thing this roster must resist is being pruned
 * to green.
 */
interface Behaviour {
  name: string;
  probe: RegExp;
  why: string;
}

const REQUIRED_BEHAVIOURS: readonly Behaviour[] = [
  {
    name: 'pointer drag: capture',
    probe: /setPointerCapture\(/,
    why: 'without capture the drag ends the moment the pointer leaves the 12px slot, which is most of any real gesture',
  },
  {
    name: 'pointer drag: release',
    probe: /releasePointerCapture\(/,
    why: 'a capture never released leaves the page swallowing pointer events for every other control',
  },
  {
    name: 'pointer drag: cancel path',
    probe: /onpointercancel=/,
    why: 'a browser-cancelled gesture (touch interrupted, OS gesture) must clear `dragging`, which otherwise gates the motorized loop off forever',
  },
  {
    name: 'lost-pointer-capture recovery',
    probe: /onlostpointercapture=/,
    why: 'a capture STOLEN by the OS fires neither up nor cancel: without this the control freezes with `dragging` true and the readLive loop gated off',
  },
  {
    name: 'click-to-jump grab radius',
    probe: /0\.08/,
    why: 'clicking away from the thumb jumps to that value, but a grab NEAR the thumb must not jump — an 8% deadband is what makes hold-and-drag feel like a fader rather than a teleport',
  },
  {
    name: 'fine modifiers latched at pointerdown',
    probe: /e\.shiftKey \? 'shift' : \(e\.ctrlKey \|\| e\.metaKey\) \? 'fine' : 'none'/,
    why: 'the modifier is read ONCE at grab; re-reading it per move would change sensitivity mid-gesture and make the value jump under the cursor',
  },
  {
    name: 'drag sensitivity ladder (100px = full range)',
    probe: /1 \/ 10000 : mod === 'shift' \? 1 \/ 1000 : 1 \/ 100/,
    why: 'the throw ladder every e2e drag assertion is calibrated against — samsloop-window and workflow-shell both compute pixel offsets from these exact ratios',
  },
  {
    name: 'wheel adjust with its own modifier ladder',
    probe: /e\.shiftKey \? 0\.001 : \(e\.ctrlKey \|\| e\.metaKey\) \? 0\.0001 : 0\.01/,
    why: 'scroll-to-adjust is a distinct gesture with a coarser step than drag; param-edit-undo drives the control through exactly this path',
  },
  {
    name: 'double-click resets to defaultValue',
    probe: /onchange\(defaultValue\)/,
    why: 'the only way back to a param default without knowing its number',
  },
  {
    name: 'rAF-coalesced commit pump',
    probe: /createDragCommit\(/,
    why: 'pointermove fires at 120-240Hz and each onchange rebuilds the patch snapshot; uncoalesced it starves the audio scheduler lookahead and causes audible drift',
  },
  {
    name: 'commit pump flushed on release',
    probe: /dragCommit\.flush\(\)/,
    why: 'without the flush a trailing rAF can be cancelled by a re-render storm and the stored value lags the last visible thumb position',
  },
  {
    name: 'commit pump disposed',
    probe: /dragCommit\.dispose\(\)/,
    why: 'a live pump on an unmounted card writes to a destroyed node — the card-unmount class (#1531)',
  },
  {
    name: 'motorized readLive rAF loop',
    probe: /requestAnimationFrame\(tick\)/,
    why: 'patching an LFO to a param must visibly move the thumb; this loop IS that behaviour and lfo-modulation-visible.spec.ts asserts it',
  },
  {
    name: 'motorized loop cancelled on teardown',
    probe: /cancelAnimationFrame\(raf\)/,
    why: 'an orphaned rAF loop per destroyed fader is an unbounded leak on a card-heavy patch',
  },
  {
    name: 'MIDI assignable factory',
    probe: /makeMidiAssignable\(\{/,
    why: 'the shared CC-vs-NOTE seam; a hand-rolled binding here would diverge from the knob and the Electra path',
  },
  {
    name: 'MIDI register on mount',
    probe: /midi\.register\(\)/,
    why: 'a binding restored from localStorage on cold start must drive the control as soon as the card mounts',
  },
  {
    name: 'MIDI unregister on destroy',
    probe: /midi\.unregister\(\)/,
    why: 'a stale setter for an unmounted control is the same node-lifetime leak as the rAF loop',
  },
  {
    name: 'MIDI streaming transient does not fight a drag',
    probe: /onTransient: \(v\) => \{ if \(!dragging\) liveValue = v; \}/,
    why: 'a CC stream and a hand on the fader must not both own the thumb; the drag wins, which is the "live wins" rule the automation seam also follows',
  },
  {
    name: 'MIDI ccActive gates the sync effects',
    probe: /midi\.ccActive/,
    why: 'store commits are coalesced, so mid-stream the store LAGS — without this gate the thumb snaps back to a stale value between CC messages',
  },
  {
    name: 'right-click opens the control menu',
    probe: /oncontextmenu=\{openContextMenu\}/,
    why: 'plain right-click is the whole discovery path for MIDI Learn / Forget on a control',
  },
  {
    name: 'control menu mounted',
    probe: /<ControlContextMenu/,
    why: 'the menu component itself — the handler above is inert without it',
  },
  {
    name: 'MIDI learning state class',
    probe: /class:midi-learning=\{midi\.learning\}/,
    why: 'the pulsing outline is the only feedback that the app is waiting for a CC to arrive',
  },
  {
    name: 'MIDI bound state class',
    probe: /class:midi-bound=\{!!midi\.binding\}/,
    why: 'distinguishes a bound control from an unbound one at a glance',
  },
  {
    name: 'MIDI CC badge',
    probe: /class="midi-badge"/,
    why: 'prints WHICH CC is bound; without it a bound control cannot be told from another bound control',
  },
  {
    name: 'automation touch-suspend on grab',
    probe: /notifyAutomationTouch\(/,
    why: 'grabbing a fader must suspend its clip-automation playback ("live wins", #183) or the envelope fights the hand',
  },
  {
    name: 'automation release',
    probe: /notifyAutomationRelease\(/,
    why: 'the override must end on PHYSICAL release, not on loop wrap, or automation never resumes',
  },
  {
    name: 'wheel automation holder auto-releases after idle',
    probe: /\}, 200\);/,
    why: 'a wheel tick has no pointer-up, so its automation hold needs an idle timer; per-surface holders keep it from clearing a concurrent pointer drag',
  },
  {
    name: 'curve mapping: log',
    probe: /curve === 'log'/,
    why: "a log param drawn linearly puts a 0.001..10s time control's midpoint three decades off",
  },
  {
    name: 'curve mapping: exp',
    probe: /curve === 'exp'/,
    why: 'the complementary skew; a def declaring exp and a control ignoring it is the backdraft divergence class',
  },
  {
    name: 'curve mapping: discrete',
    probe: /curve === 'discrete'/,
    why: 'an index param must land ON integers — without the round, a discrete fader selects fractional states that do not exist',
  },
  {
    name: 'bipolar zero hash',
    probe: /data-testid="fader-zero-hash"/,
    why: 'a param straddling zero needs its 0V crossing visible, per the global ±1 CV convention',
  },
  {
    name: 'the parity testid',
    probe: /data-testid=\{paramId \? `control-\$\{paramId\}` : undefined\}/,
    why: 'derived from paramId exactly as KnobConic does, so the card↔face control multiset comparison in faces-parity.spec.ts stays meaningful',
  },
  {
    name: 'slider role',
    probe: /role="slider"/,
    why: 'the semantic contract, and half of what DockCardHost greps to leave ctrl/meta-wheel alone',
  },
  {
    name: 'focusable',
    probe: /tabindex="0"/,
    why: 'a slider that cannot take focus can never receive the key gesture below',
  },
  {
    name: 'keyboard value gesture',
    probe: /onkeydown=\{keydown\}/,
    why: 'role="slider" PROMISES keys; the control this replaced announced the role and ignored every key. This is the control\'s own value gesture, NOT a keyboard-navigation affordance (which the owner has ruled out)',
  },
  {
    name: 'aria range',
    probe: /aria-valuemin=\{min\}/,
    why: 'the announced bounds; without them the value below has no scale',
  },
  {
    name: 'aria current value',
    probe: /aria-valuenow=\{liveValue\}/,
    why: 'must track the LIVE value so CV modulation is announced, not just the stored one',
  },
  {
    name: 'aria label',
    probe: /aria-label=\{label\}/,
    why: 'names the control; several e2e specs locate faders by [role="slider"][aria-label="…"]',
  },
  {
    name: 'aria-valuetext',
    probe: /aria-valuetext=\{readoutText\}/,
    why: 'without it a screen reader reads "0.8" where the screen says "-1.9 dB" — the raw number and the formatted one are different facts',
  },
  {
    name: 'hover value tag',
    probe: /class="value-tag"/,
    why: 'the only readout at the lane tier, where there is no room for a persistent line; vca-face.spec.ts asserts its text',
  },
  // ⚠ 'persistent readout at the faceplate tier' WAS A ROW HERE AND IS DELETED
  // — not to make a suite pass, but because the owner removed the thing it
  // required. Its `why` was a PARITY argument ("a faceplate does not print
  // values for its dials and not for its throws"), which was sound while dials
  // printed. Owner ruling 2026-08-17: *"we should kill the light white decimil
  // represebtation of knob state in ALL modules"* and, when asked whether a
  // hover reveal would do, *"i want the data gone, not there but hidden or
  // something"*. Dials stopped printing too, so parity is restored by NEITHER
  // having it, and a row demanding the element would be a gate insisting on
  // exactly what was removed.
  //
  // What survives is stronger and is the row directly above: `aria-valuetext`
  // carries the value at EVERY tier, not just the dock, so the value is still
  // speakable and still assertable — which is what let the affected specs keep
  // their subject instead of being weakened.
  {
    name: 'formatValue override honoured',
    probe: /formatValue \? formatValue\(v\) : format\(v, units\)/,
    why: "a def-declared format must beat the primitive's own ladder, or the card prints one law (0.25) and the dock prints another (CLOSED)",
  },
  {
    name: 'the .fader-wrap class DockCardHost greps for',
    probe: /class="fader-wrap/,
    why: 'DockCardHost.onFrameWheel leaves ctrl/meta-wheel to `.knob-wrap, .fader-wrap, [role="slider"]` — lose the class and fine-adjust over the control silently becomes a DOCK ZOOM, a defect with no error and no visual tell',
  },
  {
    name: 'the accent chain, not a chosen colour',
    probe: /--_ka: var\(--ka, var\(--domain, var\(--accent\)\)\)/,
    why: 'the fader takes its hue from the module domain exactly as KnobConic does, so re-skinning moves both controls together and no hex is picked in the control — this is what makes video faders violet without a per-card override (#1794)',
  },
  {
    name: 'the glyph rail',
    probe: /class="glyph-rail"/,
    why: 'LFO shape sliders are unreadable without the sine/tri/saw/square icons beside the slot; four cards pass `glyphs` and would silently lose them',
  },
  {
    name: 'the tick rail',
    probe: /class="tick-rail"/,
    why: 'discrete snap points need their captions ("1/8", "Norm", "+200%"); six cards pass `ticks` and the values are meaningless as bare indices',
  },
];

describe('NeonFader — the throw\'s behaviour contract', () => {
  it('the source really loaded (an empty glob would green every clause below)', () => {
    expect(NEON.length, 'NeonFader.svelte').toBeGreaterThan(5_000);
  });

  it('every required behaviour is present', () => {
    const missing = REQUIRED_BEHAVIOURS.filter((b) => !b.probe.test(NEON)).map((b) => b.name);
    expect(
      missing,
      'the shipped fader lost a behaviour it is required to have. Port it back rather than ' +
        'deleting the row — the row is the requirement, not a description of the code.',
    ).toEqual([]);
  });

  it('every row argues for itself (the `why` the type demands is not a placeholder)', () => {
    const thin = REQUIRED_BEHAVIOURS.filter((b) => b.why.length <= 40).map((b) => b.name);
    expect(thin, 'a probe without an argument is a diff, not a requirement').toEqual([]);
    const dupes = REQUIRED_BEHAVIOURS.map((b) => b.name).filter((n, i, a) => a.indexOf(n) !== i);
    expect(dupes, 'duplicate row names make a failure ambiguous').toEqual([]);
  });

  it('NEGATIVE CONTROL: the probes really can fail', () => {
    // A sweep of always-true regexes would look identical to a passing one.
    expect(/this-string-is-in-no-control/.test(NEON)).toBe(false);
  });

  it('POSITIVE CONTROL: removing a behaviour from the source reddens ITS row, and only its row', () => {
    // ⚠ THE LEG THAT MAKES THE ONE ABOVE MEAN SOMETHING. A negative control only
    // proves a probe CAN return false; it does not prove the roster is reading
    // the file under test, or that a given row is the one that would catch a
    // given regression. This perturbs the REAL source and re-runs the REAL
    // sweep, so a row wired to the wrong text shows up as "the perturbation
    // reddened nothing" (or as the wrong name) instead of as a green gate.
    for (const target of [
      'automation touch-suspend on grab',
      'rAF-coalesced commit pump',
      'the accent chain, not a chosen colour',
    ]) {
      const row = REQUIRED_BEHAVIOURS.find((b) => b.name === target)!;
      // ⚠ GLOBAL, and the first draft of this leg was not — which is how it
      // FOUND ITS OWN BUG. `notifyAutomationTouch(` appears TWICE in the source
      // (the pointer holder and the wheel holder), so a non-global `replace`
      // removed one occurrence, the probe still matched the other, and the
      // perturbation reddened nothing while claiming to prove it could.
      const all = new RegExp(row.probe.source, 'g');
      const hole = NEON.replace(all, '/* removed by the positive control */');
      expect(hole, `the perturbation did not change the source for: ${target}`).not.toBe(NEON);
      const missing = REQUIRED_BEHAVIOURS.filter((b) => !b.probe.test(hole)).map((b) => b.name);
      expect(
        missing,
        `removing "${target}" from the source must redden exactly that row. If it reddens ` +
          'nothing, the row is not reading this file. If it reddens more, two rows share a ' +
          'probe and a failure cannot say which behaviour went missing.',
      ).toEqual([target]);
    }
  });

  it('the DELETED control is really gone (the migration this roster was re-founded for)', () => {
    // Anchored to the artifact rather than to prose: if `Fader.svelte` ever
    // comes back, this file's whole premise — "there is one throw" — is false
    // and the two-sided comparison should be restored rather than quietly
    // running single-sided against one of two controls.
    expect(
      Object.keys(SRC).filter((k) => /\/Fader\.svelte$/.test(k)),
      'Fader.svelte is back in $lib/ui/controls. This roster was re-founded as single-sided ' +
        'BECAUSE it was deleted (#1794) — restore the two-sided comparison, or delete the ' +
        'reintroduced control.',
    ).toEqual([]);
  });
});
