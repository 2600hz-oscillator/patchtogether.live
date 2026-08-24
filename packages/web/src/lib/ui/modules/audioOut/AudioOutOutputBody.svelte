<script lang="ts">
  // packages/web/src/lib/ui/modules/audioOut/AudioOutOutputBody.svelte
  //
  // THE AUDIO OUT dock full-view body: the terminal stereo meter, plus the
  // output-device picker.
  //
  // ⚠ WHY THE TWO ARE ONE SURFACE. They are the two halves of the only question
  // a player asks this module: WHERE IS MY SOUND GOING, and IS IT ALRIGHT WHEN
  // IT GETS THERE. Neither can be expressed as a `ParamDef`: one is a picture
  // and the other is a runtime `enumerateDevices()` roster.
  //
  // ⚠ THE METER IS NEW PRODUCT, NOT A PORT OF THE CARD. `AudioOutCard` has no
  // meter and never had one, so the rack's terminal has never been able to tell
  // you whether it is clipping. The data was already there and unread: three
  // analyser taps hang off `tail` — the exact node feeding `ctx.destination`,
  // so they see the master gain AND the limiter's action — and they exist
  // solely for e2e audibility assertions. This is the owner's first named
  // width-earner ("a live picture") on the module the picture is about, at zero
  // new engine cost.
  //
  // ⚠ IT READS THE PER-CHANNEL KEYS, AND THAT IS THE POINT. The maths lives in
  // `$lib/ui/modules/audioOut/audio-out-meter` and takes the READ FUNCTION, so
  // `audioout-face-model.test.ts` can hand it a fake that records the keys and
  // prove a mono-key regression red. An `AnalyserNode` analyses a mono downmix,
  // so `read('outputSnapshot')` cannot tell only-L from only-R and reads ~0 for
  // an anti-phase pair — the exact blindness the per-channel taps were added to
  // remove.
  //
  // ⚠ NOTHING NUMERIC IS PAINTED. No dB readout, no peak value, no ceiling
  // label, no axis numbers. The bar, the ceiling mark and the tick marks are the
  // picture; the measurement lives in `aria-valuetext`, which is speakable and
  // assertable and unpainted. A labelled row of derived values under a picture
  // is the hero readout strip deleted fleet-wide on 2026-08-19, and a dB scale
  // reading "−1" beside a brickwall mark is that strip with a haircut.
  //
  // ⚠ NO SCREEN ON/OFF SWITCH, and this is the ruling applied rather than
  // skipped. `video-face-screen-source.test.ts` sweeps
  // `listVideoModuleDefs() ∩ STRICT_FACES`; audioOut is `domain: 'audio'`, so
  // the gate cannot reach it either way and needs no exemption. On the merits it
  // is `videoOut`'s argument, which `dockscope`, `spectrograph` and `samsloop`
  // each already applied: when the picture IS the module, collapsing it deletes
  // the product. A face with this meter collapsed is a face with one fader on
  // it, and the reason to open AUDIO OUT is to see the level. Do not add a
  // switch whose off state is an empty plate. (If the owner wants one it is a
  // `previewCollapsed` key on `node.data` — never component `$state`, the
  // card-unmount class — and it must skip the PAINT, never the read loop.)
  //
  // ⚠ THE DRAW LOOP IS VISIBILITY-GATED by construction: `onMeterFrame` is the
  // shared rAF that skips off-screen subscribers. There is no second loop here.
  import { patch } from '$lib/graph/store';
  import { onMeterFrame } from '$lib/ui/meter-frame';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    AUDIO_OUT_METER_FLOOR_DB,
    ceilingFraction,
    meterFraction,
    meterValueText,
    readTerminalLevels,
    type TerminalLevels,
  } from '$lib/ui/modules/audioOut/audio-out-meter';
  import {
    ensureOutputDeviceWatch,
    outputDeviceOptions,
    outputDeviceRoster,
    outputDeviceValue,
    outputPickerBlock,
    outputPickerValueText,
    outputSinkError,
    setOutputDevice,
  } from '$lib/audio/output-device.svelte';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();
  let node = $derived(patch.nodes[nodeId] as ModuleNode | undefined);

  // ── THE PICKER ───────────────────────────────────────────────────────────
  //
  // The roster is app-wide (`output-device.svelte.ts`), so however many
  // surfaces paint a picker there is ONE enumeration and ONE `devicechange`
  // listener. Started from an effect, never from a render.
  $effect(() => {
    ensureOutputDeviceWatch();
  });

  let devices = $derived(outputDeviceRoster());
  let options = $derived(outputDeviceOptions(devices));
  let picked = $derived(outputDeviceValue(node, devices));
  /** `'unsupported'` | `'no-devices'` | null — TWO causes, and the card could
   *  tell them apart in neither its disabled state nor its notice. */
  let block = $derived(outputPickerBlock(devices));
  let pickerText = $derived(outputPickerValueText(node, devices));
  let sinkError = $derived(outputSinkError(node));

  // ── THE METER ────────────────────────────────────────────────────────────

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let levels = $state<TerminalLevels | null>(null);
  /** Peak-hold, per channel, in bar FRACTION. The tail is a product-side
   *  interval: any e2e that waits on it writes a `// pacing:` comment naming
   *  this decay. */
  let holdL = 0;
  let holdR = 0;
  const HOLD_DECAY_PER_FRAME = 0.006;

  function paint(c: HTMLCanvasElement, lv: TerminalLevels | null): void {
    const rect = c.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const g = c.getContext('2d');
    if (!g) return;

    g.clearRect(0, 0, w, h);
    // THE IDLE FIELD IS DRAWN, NOT BLANK. "Found nothing" and "not on this
    // surface" have to be different pictures, or a body that failed to mount
    // takes an indistinguishable baseline.
    g.fillStyle = '#0a0c10';
    g.fillRect(0, 0, w, h);

    const pad = Math.round(6 * dpr);
    const gap = Math.round(5 * dpr);
    const barH = Math.round((h - pad * 2 - gap) / 2);
    const barW = w - pad * 2;
    if (barW <= 0 || barH <= 0) return;

    const lF = lv ? meterFraction(lv.l) : 0;
    const rF = lv ? meterFraction(lv.r) : 0;
    holdL = Math.max(lF, holdL - HOLD_DECAY_PER_FRAME);
    holdR = Math.max(rF, holdR - HOLD_DECAY_PER_FRAME);

    const ceil = ceilingFraction();
    for (const [i, frac, hold] of [
      [0, lF, holdL],
      [1, rF, holdR],
    ] as const) {
      const y = pad + i * (barH + gap);
      // the well
      g.fillStyle = '#141920';
      g.fillRect(pad, y, barW, barH);
      // the level
      if (frac > 0) {
        const grad = g.createLinearGradient(pad, 0, pad + barW, 0);
        grad.addColorStop(0, '#3f8f66');
        grad.addColorStop(0.62, '#6fce9a');
        grad.addColorStop(0.84, '#d8c765');
        grad.addColorStop(1, '#e08a6a');
        g.fillStyle = grad;
        g.fillRect(pad, y, Math.max(1, Math.round(barW * frac)), barH);
      }
      // UNLABELLED tick marks — the bar's structure, not a reading. A picture
      // needs an axis to be read against; it does not need the axis spelled
      // out, and spelling it out is the readout strip by another name.
      g.fillStyle = '#2b323c';
      for (const db of [-24, -12, -6]) {
        const x = pad + Math.round(barW * meterFraction(db));
        g.fillRect(x, y, Math.max(1, Math.round(dpr)), barH);
      }
      // THE CEILING MARK — MASTER_CEILING_DB, imported through the meter
      // module, never re-typed here.
      g.fillStyle = '#8a6a3a';
      g.fillRect(
        pad + Math.round(barW * ceil),
        y - Math.round(dpr),
        Math.max(1, Math.round(dpr)),
        barH + Math.round(dpr * 2),
      );
      // the peak-hold tick
      if (hold > 0) {
        g.fillStyle = '#e9edf3';
        g.fillRect(
          pad + Math.min(barW - 2, Math.round(barW * hold)),
          y,
          Math.max(2, Math.round(2 * dpr)),
          barH,
        );
      }
    }
  }

  $effect(() => {
    if (!canvasEl) return;
    const h = onMeterFrame(canvasEl, () => {
      const c = canvasEl;
      const n = node;
      if (!c) return;
      const eng = n ? engineCtx.get() : null;
      const next = eng && n ? readTerminalLevels((key) => eng.read(n, key)) : null;
      levels = next;
      paint(c, next);
    });
    return () => h.stop();
  });

  let meterText = $derived(meterValueText(levels));
  /** `role="meter"` needs a single `aria-valuenow`; the loudest channel is the
   *  honest one-number answer and `aria-valuetext` carries both. */
  let meterNow = $derived(
    levels ? Math.max(levels.l, levels.r) : AUDIO_OUT_METER_FLOOR_DB,
  );
</script>

<div class="audioout-body" data-testid="audioout-output-body">
  <div
    class="meter"
    role="meter"
    data-testid="audioout-face-meter"
    data-node-id={nodeId}
    aria-label="terminal output level"
    aria-valuemin={AUDIO_OUT_METER_FLOOR_DB}
    aria-valuemax={0}
    aria-valuenow={meterNow}
    aria-valuetext={meterText}
  >
    <canvas bind:this={canvasEl} data-testid="audioout-face-canvas"></canvas>
  </div>

  <label class="device">
    <span class="tag">out</span>
    <select
      data-testid="audioout-face-device-select"
      data-block={block ?? 'none'}
      value={picked}
      disabled={block !== null}
      aria-label="output device"
      aria-valuetext={pickerText}
      onchange={(e) => setOutputDevice(nodeId, (e.currentTarget as HTMLSelectElement).value)}
    >
      {#if options.length === 0}
        <option value="">(no outputs)</option>
      {:else}
        {#each options as o (o.value)}
          <option value={o.value}>{o.label}</option>
        {/each}
      {/if}
    </select>
  </label>

  <!-- ⚠ TRANSIENT, NOT RESTING. This element does not exist unless a pick was
       REJECTED — feedback on a gesture, the same shape the platform's own file
       cell paints as a status/error line under its button. At rest there is no
       error and therefore no text. `role="alert"` makes it an announcement as
       well as a line, so the failure reaches a screen reader without a second
       mechanism. -->
  {#if sinkError}
    <div class="sink-err" role="alert" data-testid="audioout-face-sink-error">{sinkError}</div>
  {/if}
</div>

<style>
  /* ⚠ THIS BODY CONTRIBUTES NO INTRINSIC WIDTH, AND THAT WAS A MEASURED FIX.
     It first pinned the meter at a fixed 300 px inside a `width: max-content`
     column, which put a 46 px band of EMPTY PLATE to the right of the content
     (content 340, plate 386) — caught by the per-face content-vs-plate
     measurement against its 40 px ceiling, which is the runtime half of the
     "width must be EARNED" ruling and exactly the tidyVco defect in miniature.
     The plate was never 300 wide; the rest of the faceplate set 386 and the
     body simply declined to fill it.
     `width: 100%` resolves as `auto` for the parent's intrinsic sizing (the
     same CSS fact `.dock-natural-sized` relies on), so the body adds nothing to
     how wide the plate WANTS to be and then occupies all of whatever it turns
     out to be. No floor, no `FACE_WIDTH_EXEMPTIONS` entry, and no number here
     that can go stale when a neighbour changes. */
  .audioout-body {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 8px 0 2px;
    width: 100%;
    min-width: 0;
  }
  /* ⚠ NO HORIZONTAL PADDING, NO FRAME, AND THE CANVAS IS THE OUTERMOST BOX.
     MEASURED: a 10 px body inset + 2 px meter inset + a 1 px frame put the
     canvas 13 px short of where an ordinary face's widest cell sits, which took
     the plate's unused-width slack from the 33 px every face carries to 46 —
     past the 40 px ceiling. The frame bought nothing the meter's own dark well
     does not already draw, so it is gone rather than exempted. */
  .meter {
    width: 100%;
  }
  .meter canvas {
    display: block;
    width: 100%;
    height: 34px;
    border-radius: 3px;
    background: #0a0c10;
  }
  .device {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 0.65rem;
    color: var(--text-dim);
    width: 100%;
    min-width: 0;
  }
  .tag {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
  }
  .device select {
    flex: 1 1 auto;
    min-width: 0;
    background: #151a21;
    color: var(--text);
    border: 1px solid #3a4048;
    border-radius: 3px;
    padding: 2px 4px;
    font-size: 0.65rem;
    font-family: ui-monospace, monospace;
  }
  .device select:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .sink-err {
    font-size: 0.6rem;
    color: #fca5a5;
    line-height: 1.2;
    width: 100%;
    min-width: 0;
  }
</style>
