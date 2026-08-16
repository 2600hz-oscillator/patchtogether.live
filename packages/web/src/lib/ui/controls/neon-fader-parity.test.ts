// packages/web/src/lib/ui/controls/neon-fader-parity.test.ts
//
// #1738 — NEONFADER KEEPS EVERY BEHAVIOUR `Fader.svelte` HAS.
//
// The owner's standing rule is that functional parity is a hard requirement, and
// a NEW control is the one change shape where parity is easiest to lose by
// accident: nothing fails to compile when a copy silently omits the automation
// touch-suspend, or the MIDI badge, or the coalesced commit pump. The old
// widget is still in the tree, so the honest gate is a DIRECT COMPARISON rather
// than a re-description of it.
//
// ⚠ WHAT THIS GATE STRUCTURALLY CANNOT SEE:
//   * PIXELS and layout — it reads source. `face-mixmstrs-*.png` are the pixels.
//   * SEMANTICS. It proves `NeonFader` calls `notifyAutomationTouch`; it cannot
//     prove it calls it at the right moment. The behaviour-level proof is
//     `faces-parity.spec.ts` (which now drives both throws through ONE arm) and
//     `workflow-drawer-face.spec.ts` (drag → graph, right-click → MIDI learn).
//   * `Fader.svelte`'s own correctness — if the shipped control loses a
//     behaviour, this gate goes green by following it down. It is a
//     DIVERGENCE detector, not a floor.

import { describe, expect, it } from 'vitest';

const SRC = import.meta.glob('./*.svelte', { eager: true, query: '?raw', import: 'default' }) as Record<
  string,
  string
>;
const FADER = SRC['./Fader.svelte'] ?? '';
const NEON = SRC['./NeonFader.svelte'] ?? '';

/**
 * The behaviours BOTH throws must have. Each entry is a probe that must match
 * in both files — named, so a failure says which capability went missing rather
 * than "a regex did not match".
 *
 * ⚠ DENY BY DEFAULT: the parity sweep below asserts each of these in BOTH
 * files. Removing a row to make the suite pass is the failure mode this exists
 * for, so the roster is also asserted against `Fader.svelte` — a row naming a
 * behaviour the SHIPPED control no longer has is red too.
 */
const SHARED_BEHAVIOURS: readonly { name: string; probe: RegExp }[] = [
  { name: 'pointer drag: capture', probe: /setPointerCapture\(/ },
  { name: 'pointer drag: release', probe: /releasePointerCapture\(/ },
  { name: 'pointer drag: cancel path', probe: /onpointercancel=/ },
  { name: 'click-to-jump grab radius', probe: /0\.08/ },
  { name: 'fine modifiers latched at pointerdown', probe: /e\.shiftKey \? 'shift' : \(e\.ctrlKey \|\| e\.metaKey\) \? 'fine' : 'none'/ },
  { name: 'drag sensitivity ladder (100px = full range)', probe: /1 \/ 10000 : mod === 'shift' \? 1 \/ 1000 : 1 \/ 100/ },
  { name: 'wheel adjust with its own modifier ladder', probe: /e\.shiftKey \? 0\.001 : \(e\.ctrlKey \|\| e\.metaKey\) \? 0\.0001 : 0\.01/ },
  { name: 'double-click resets to defaultValue', probe: /onchange\(defaultValue\)/ },
  { name: 'rAF-coalesced commit pump', probe: /createDragCommit\(/ },
  { name: 'commit pump flushed on release', probe: /dragCommit\.flush\(\)/ },
  { name: 'commit pump disposed', probe: /dragCommit\.dispose\(\)/ },
  { name: 'motorized readLive rAF loop', probe: /requestAnimationFrame\(tick\)/ },
  { name: 'motorized loop cancelled on teardown', probe: /cancelAnimationFrame\(raf\)/ },
  { name: 'MIDI assignable factory', probe: /makeMidiAssignable\(\{/ },
  { name: 'MIDI register on mount', probe: /midi\.register\(\)/ },
  { name: 'MIDI unregister on destroy', probe: /midi\.unregister\(\)/ },
  { name: 'MIDI streaming transient does not fight a drag', probe: /onTransient: \(v\) => \{ if \(!dragging\) liveValue = v; \}/ },
  { name: 'MIDI ccActive gates the sync effects', probe: /midi\.ccActive/ },
  { name: 'right-click opens the control menu', probe: /oncontextmenu=\{openContextMenu\}/ },
  { name: 'control menu mounted', probe: /<ControlContextMenu/ },
  { name: 'MIDI learning state class', probe: /class:midi-learning=\{midi\.learning\}/ },
  { name: 'MIDI bound state class', probe: /class:midi-bound=\{!!midi\.binding\}/ },
  { name: 'MIDI CC badge', probe: /class="midi-badge"/ },
  { name: 'automation touch-suspend on grab', probe: /notifyAutomationTouch\(/ },
  { name: 'automation release', probe: /notifyAutomationRelease\(/ },
  { name: 'wheel automation holder auto-releases after idle', probe: /\}, 200\);/ },
  { name: 'curve mapping: log', probe: /curve === 'log'/ },
  { name: 'curve mapping: exp', probe: /curve === 'exp'/ },
  { name: 'curve mapping: discrete', probe: /curve === 'discrete'/ },
  { name: 'bipolar zero hash', probe: /data-testid="fader-zero-hash"/ },
  { name: 'the parity testid', probe: /data-testid=\{paramId \? `control-\$\{paramId\}` : undefined\}/ },
  { name: 'slider role', probe: /role="slider"/ },
  { name: 'focusable', probe: /tabindex="0"/ },
  { name: 'aria range', probe: /aria-valuemin=\{min\}/ },
  { name: 'aria current value', probe: /aria-valuenow=\{liveValue\}/ },
  { name: 'aria label', probe: /aria-label=\{label\}/ },
  { name: 'hover value tag', probe: /class="value-tag"/ },
  { name: 'formatValue override honoured', probe: /formatValue \? formatValue\(v\)|if \(formatValue\) return formatValue\(v\)/ },
  // ⚠ THE DOCK-ZOOM EXEMPTION. `DockCardHost.onFrameWheel` leaves ctrl/meta
  // wheel alone for `.knob-wrap, .fader-wrap, [role="slider"]`. Lose the class
  // and fine-adjust over the control silently becomes a dock zoom instead —
  // a defect with no error and no visual tell.
  { name: 'the .fader-wrap class DockCardHost greps for', probe: /class="fader-wrap/ },
];

describe('NeonFader ↔ Fader — behaviour parity (#1738)', () => {
  it('both sources really loaded (an empty glob would green every clause below)', () => {
    expect(FADER.length, 'Fader.svelte').toBeGreaterThan(5_000);
    expect(NEON.length, 'NeonFader.svelte').toBeGreaterThan(5_000);
  });

  it('every enumerated behaviour is present in BOTH controls', () => {
    const missingFromNeon = SHARED_BEHAVIOURS.filter((b) => !b.probe.test(NEON)).map((b) => b.name);
    expect(
      missingFromNeon,
      'NeonFader is missing behaviour the shipped Fader has. A new control that drops a ' +
        'capability is a degradation, not a redesign — port it rather than deleting the row.',
    ).toEqual([]);
  });

  it('…and the roster is ANCHORED to the shipped control, so a stale row is RED', () => {
    // The other direction of the same gate. Without it, a row could name a
    // behaviour neither control has and the sweep above would still pass.
    const missingFromFader = SHARED_BEHAVIOURS.filter((b) => !b.probe.test(FADER)).map((b) => b.name);
    expect(
      missingFromFader,
      'this row names a behaviour Fader.svelte no longer has. Either the shipped control ' +
        'regressed, or the row is stale — do not "fix" it by deleting the probe.',
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: the probes really can fail, in both directions', () => {
    // A sweep of always-true regexes would look identical to a passing one.
    const bogus = /this-string-is-in-neither-control/;
    expect(bogus.test(NEON)).toBe(false);
    expect(bogus.test(FADER)).toBe(false);
    // …and a probe for something only ONE of them has must distinguish them —
    // proving the two files are genuinely different inputs and not the same
    // string read twice.
    expect(/onkeydown=/.test(NEON), 'the new control has the key handler').toBe(true);
    expect(/onkeydown=/.test(FADER), 'the shipped one does not').toBe(false);
  });
});

// ── THE DELIBERATE ADDITIONS ───────────────────────────────────────────────
//
// Everything NeonFader has that Fader does not. Each is an ADDITION; the sweep
// above is what guarantees none of them arrived by trading a behaviour away.
describe('NeonFader — the three gaps it closes, asserted so they cannot be dropped', () => {
  const ADDITIONS: readonly { name: string; probe: RegExp; why: string }[] = [
    {
      name: 'keyboard value gesture',
      probe: /onkeydown=\{keydown\}/,
      why:
        'Fader.svelte carries role="slider" and tabindex="0" and NO key handler, i.e. it ' +
        'announces a slider to assistive tech and then ignores every key. This is the ' +
        "control's own value gesture, not a keyboard-navigation affordance.",
    },
    {
      name: 'aria-valuetext',
      probe: /aria-valuetext=\{readoutText\}/,
      why:
        'KnobConic emits it and Fader does not, so a screen reader read the raw number where ' +
        'the screen showed formatted units.',
    },
    {
      name: 'persistent readout at the faceplate tier',
      probe: /data-testid=\{paramId \? `readout-\$\{paramId\}` : undefined\}/,
      why:
        "a dock band has the row for a value line and a 192px lane tile does not — the same " +
        'split KnobConic already makes, so a faceplate stops printing values for its dials ' +
        'and not for its throws.',
    },
    {
      name: 'lost-pointer-capture recovery',
      probe: /onlostpointercapture=/,
      why:
        'KnobConic has one and Fader does not: a capture stolen by the OS leaves `dragging` ' +
        'true forever, which gates the motorized loop off and FREEZES the control.',
    },
  ];

  it('each addition is present, and each carries its reason', () => {
    for (const a of ADDITIONS) {
      expect(a.probe.test(NEON), `${a.name} — ${a.why}`).toBe(true);
      expect(a.why.length, `${a.name}: an addition without a reason is a diff`).toBeGreaterThan(40);
    }
  });

  it('…and they are genuinely ADDITIONS — the shipped control has none of them', () => {
    // If one of these ever lands in Fader.svelte too, this row is stale and
    // should move into SHARED_BEHAVIOURS rather than being deleted.
    const alreadyInFader = ADDITIONS.filter((a) => a.probe.test(FADER)).map((a) => a.name);
    expect(
      alreadyInFader,
      'Fader.svelte gained this behaviour — move the row into SHARED_BEHAVIOURS so BOTH ' +
        'controls are held to it.',
    ).toEqual([]);
  });
});
