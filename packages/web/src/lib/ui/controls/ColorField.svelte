<script lang="ts">
  // ColorField — the RACKLINE COLOUR CELL for a PACKED 24-BIT RGB param.
  //
  // The fourth answer to "how does a discrete param show its states", and the
  // first one that is not a roster: Segmented lays <=6 named states out inline,
  // Selector shows a 7+ roster as a portaled list, ParamGrid charts states that
  // are pictures — and none of them can present SIXTEEN POINT SEVEN MILLION
  // states, which is what `0..0xffffff discrete` is. Without this the shell
  // resolved that shape to a KnobConic: a dial whose every drag step lands on
  // an unpredictable hue, printing `4292546867`.
  //
  // ⚠ THE INPUT IS THE CONTROL, NOT A SWATCH BEHIND ONE. The legacy card hides
  // a zero-opacity `<input type="color">` under a decorative `<span>`
  // (WavesculptCard `.chroma-swatch`), which works for a human but makes the
  // visible thing and the operable thing two different elements — so a probe
  // can drive one while the other is dead, and `toBeVisible()` on the swatch
  // proves nothing about the input. Here the input IS the painted swatch
  // (native `-webkit-color-swatch` styling), so "visible" and "operable" are
  // one element and one assertion.
  //
  // ── WHAT MAKES THE PARITY PROBE HONEST ──────────────────────────────────
  //
  // A colour control has a failure mode a knob does not: it can be DECORATION.
  // A coloured rectangle that never writes looks correct in a screenshot, in a
  // VRT baseline, and to any assertion that only checks a control mounted.
  //
  // So this component publishes a WITNESS that a decorative swatch cannot
  // fake: `colorhex-<paramId>` prints the hex of the **`value` prop** — the
  // live param, arriving back from the graph — never of the input's own
  // internal state. The two are indistinguishable while everything works and
  // diverge the moment the write path is cut: the native input keeps showing
  // whatever the user picked (the browser owns that), while the witness keeps
  // showing the value the graph actually holds. `faces-parity`'s `color` branch
  // asserts the witness reaches the EXACT expected hex, which is the same
  // "drive one element, watch a different one" discipline the PANEL cells use.
  //
  // ⚠ Deliberately NOT MIDI-assignable, and not an omission. A packed RGB is
  // three values in one integer; a 7-bit CC sweeping it would walk a diagonal
  // through colour space, and 1-bit steps of the CC would flip the RED channel.
  // The legacy card already reasoned this out ("Not a single-CC param … so it's
  // correctly exempt from the MIDI-Learn audit") and that audit only scans
  // <Knob>/<NeonFader>, so this is consistent rather than an escape.
  //
  // ⚠ NO `readLive`. Every other primitive polls a live reader on rAF for
  // CV/motorized displacement. A colour param has no CV jack anywhere in the
  // repo (a colour is not a scalar), so a reader here would be three rAF loops
  // per module returning the value we already have — and, worse, it would make
  // the witness read from a DIFFERENT source than the swatch, which is exactly
  // the self-referential shape the witness exists to avoid.
  import { clampPacked, hexToPacked, packedToHex } from './color-field-model';

  interface Props {
    /** Current packed value (`r*65536 + g*256 + b`). */
    value: number;
    /** Commit a new packed value (`params.set(paramId)`). */
    onchange: (value: number) => void;
    /**
     * The param's declared range. Passed from the DEF by the caller and used
     * to CLAMP — never re-typed here. The one place the packed-RGB bounds are
     * written is `color-field-model`, and `module-face-lint` asserts every
     * def declaring a `'color'` cell agrees with it, so the card-range-source
     * divergence class has no room to open.
     */
    min?: number;
    max?: number;
    /** Small uppercase tag above the swatch (the param's label). */
    label?: string;
    /** MIDI-Learn addressing is NOT offered (see the header); `paramId` is
     *  still required — it is what carries `control-<paramId>` into
     *  faces-parity's dock multiset. */
    paramId?: string;
    /** Hero-sized (the dock faceplate). */
    hero?: boolean;
    /** LANE-TILE size: shrinks into the 46 px `--kcol-max` knob column. */
    compact?: boolean;
    disabled?: boolean;
  }

  let {
    value,
    onchange,
    min = 0,
    max = 0xffffff,
    label,
    paramId,
    hero = false,
    compact = false,
    disabled = false,
  }: Props = $props();

  /** The committed value, clamped to the DEF's declared span. */
  let committed = $derived(Math.max(min, Math.min(max, clampPacked(value))));
  /** What the swatch shows AND what the witness prints — one source. */
  let hex = $derived(packedToHex(committed));

  function onPick(e: Event): void {
    if (disabled) return;
    const raw = (e.currentTarget as HTMLInputElement).value;
    const packed = hexToPacked(raw);
    // A parse failure keeps the current value. `hexToPacked` returns null
    // rather than 0 precisely so a browser oddity cannot be committed as
    // BLACK — a legal colour, and therefore an invisible corruption.
    if (packed === null) return;
    const next = Math.max(min, Math.min(max, packed));
    if (next !== committed) onchange(next);
  }
</script>

<div class="cf-wrap" class:hero class:compact class:disabled>
  {#if label && !compact}<span class="cf-lab">{label}</span>{/if}
  <input
    type="color"
    class="cf-swatch nodrag"
    value={hex}
    {disabled}
    aria-label={label ? `${label}: ${hex}` : hex}
    title={label ? `${label} — pick a colour (${hex})` : `Pick a colour (${hex})`}
    data-testid={paramId ? `control-${paramId}` : undefined}
    oninput={onPick}
  />
  <!-- THE WITNESS. Derived from the `value` PROP (the graph), never from the
       input's own state, so a swatch whose write path is severed keeps showing
       the colour the graph still holds while the native picker shows the one
       the user chose. That divergence is the whole assertion. -->
  <span class="cf-hex" data-testid={paramId ? `colorhex-${paramId}` : undefined}>{hex}</span>
</div>

<style>
  .cf-wrap {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .cf-lab {
    font-size: 9px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-dim);
    white-space: nowrap;
  }
  /* The native input IS the swatch — see the header. Chromium paints the
     colour through `::-webkit-color-swatch`, so the border/radius have to be
     removed there as well as on the host or the well shows a grey frame. */
  .cf-swatch {
    -webkit-appearance: none;
    appearance: none;
    width: 40px;
    height: 26px;
    padding: 0;
    border: 1px solid var(--border-strong, #333b48);
    border-radius: 6px;
    background: transparent;
    cursor: pointer;
    outline: none;
  }
  .cf-swatch::-webkit-color-swatch-wrapper { padding: 2px; }
  .cf-swatch::-webkit-color-swatch { border: none; border-radius: 4px; }
  .cf-swatch::-moz-color-swatch { border: none; border-radius: 4px; }
  .cf-swatch:hover { border-color: var(--domain, var(--accent)); }
  .cf-swatch:focus-visible { outline: 2px solid var(--domain, var(--accent)); outline-offset: 2px; }

  .cf-wrap.hero .cf-swatch { width: 56px; height: 32px; }
  .cf-wrap.compact .cf-swatch { width: 100%; height: 18px; border-radius: 4px; }
  .cf-wrap.compact { width: 100%; }

  .cf-hex {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 9px;
    letter-spacing: 0.02em;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .cf-wrap.hero .cf-hex { font-size: 10px; color: var(--domain, var(--accent)); }
  .cf-wrap.compact .cf-hex { font-size: 8px; }

  .cf-wrap.disabled { opacity: 0.5; }
  .cf-wrap.disabled .cf-swatch { cursor: default; }
</style>
