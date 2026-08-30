<script lang="ts">
  // StatusLed — THE FACEPLATE INDICATOR. A dark or lit lamp with a static
  // caption; the measurement it indicates lives in `aria-label` / `title` and
  // never in a text node.
  //
  // See `status-led-model.ts` for the full argument. The short version: the
  // resting faceplate may paint the module NAME, section LABELS, control
  // CAPTIONS and option NAMES — and nothing else. Three mechanisms have been
  // deleted for painting a derived value, each one denied by name and each one
  // replaced by the next. This component is the positive form: the ONLY status
  // surface a face may use, shaped so the refused form cannot be expressed.
  //
  // ⚠ NO `value` PROP. Compare `Readout.svelte`, which is the refused shape
  // preserved next door: `{ value, units, precision }` and a text node. Adding
  // one here is an edit to a gated file (`status-led-source.test.ts`), not a
  // call-site choice.
  //
  // ⚠ THE CAPTION IS STATIC BY CONTRACT, not by convention: it is announced and
  // painted identically whether `lit` is true or false, so a caller cannot pass
  // `lit ? 'LATE 3' : 'OK'` and have it read as a caption — it would read as a
  // caption that changes, which the source gate denies at the call site.
  import { statusLedLabel, statusLedTitle } from './status-led-model';

  interface Props {
    /** The STATIC name of the indicated thing (`LATE`, `ROUTED`). */
    caption: string;
    /** The whole visual state: dark or lit. */
    lit: boolean;
    /** The derived quantity/sentence — `aria-label` + `title` ONLY. */
    detail?: string;
    /** `warn` tints the LIT state amber instead of the domain accent, for an
     *  indicator whose lit state is a FAULT rather than a readiness. Colour,
     *  not text — and it changes nothing about what is announced. */
    tone?: 'accent' | 'warn';
    testid?: string;
  }

  let { caption, lit, detail, tone = 'accent', testid }: Props = $props();

  let label = $derived(statusLedLabel({ caption, lit, detail }));
  let title = $derived(statusLedTitle({ caption, lit, detail }));
</script>

<span
  class="status-led {tone}"
  class:lit
  data-testid={testid}
  data-lit={lit ? '1' : '0'}
  role="img"
  aria-label={label}
  {title}
>
  <span class="lamp" aria-hidden="true"></span>
  <span class="cap">{caption}</span>
</span>

<style>
  .status-led {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.6px;
    color: var(--muted, #888);
    text-transform: uppercase;
  }
  /* The lamp IS the measurement. Dark = the ordinary resting state, so a
     healthy faceplate is quiet; a lit lamp is the thing worth looking at. */
  .lamp {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--border, #3a3a3a);
    box-shadow: inset 0 0 2px rgba(0, 0, 0, 0.8);
    flex: 0 0 auto;
  }
  .status-led.lit .lamp {
    background: var(--cable-cv, #6cf);
    box-shadow: 0 0 6px var(--cable-cv, #6cf);
  }
  .status-led.warn.lit .lamp {
    background: var(--warn, #e6b800);
    box-shadow: 0 0 6px var(--warn, #e6b800);
  }
  .status-led.lit .cap { color: var(--fg, #ddd); }
  .status-led.warn.lit .cap { color: var(--warn, #e6b800); }
</style>
