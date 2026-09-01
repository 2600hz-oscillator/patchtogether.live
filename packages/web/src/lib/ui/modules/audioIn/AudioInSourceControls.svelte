<script lang="ts">
  // The four things AUDIO IN needs that are not `ParamDef`s — the DEVICE
  // PICKER, the capture LAMPS, the ACQUIRE/STOP gesture and MUSIC MODE — as ONE
  // component both of the module's face surfaces mount.
  //
  // ⚠ IT EXISTS FOR THE REASON `CameraSourceControls` EXISTS, AND THE PRECEDENT
  // IS APPLIED RATHER THAN COPIED. That component's own header records the
  // shipped regression it repairs: the camera extension filled `fullViewBody`
  // and nothing else, so the picker and — far worse — the ONLY clickable route
  // to `getUserMedia` lived in the dock full view alone, and the lane tile could
  // neither choose a device nor START one. AUDIO IN would have inherited that
  // verbatim: ENABLE is the only route to a first permission grant, so shipping
  // it in `fullViewBody` alone would put a rack's microphone one expand away
  // from existing at all.
  //
  // ⚠ `testidPrefix` IS NOT COSMETIC. A faced module's LANE TILE and its DOCK
  // FULL VIEW can be on screen at the same time, so a single hardcoded testid
  // would resolve to two elements and every Playwright strict locator over it
  // would throw. Each mount site passes its own prefix.
  //
  // ⚠ AND NEITHER PREFIX MAY BE `audioin-…`. `workflow-audio-io-face.spec.ts`
  // uses `audioin-device-select` as its LEGACY-ONLY marker — the positive
  // statement that the 🎧 tray mounted the verbatim card rather than a face —
  // and asserts it is GONE once the face renders. A body reusing that testid
  // would make the spec's two arms indistinguishable.
  //
  // ⚠ IT IS NOT A SECOND OWNER. Every gesture routes through
  // `./audio-in-actions`; the stream stays on `node-audio-input-registry` (NODE
  // lifetime, #1590) and the roster on `$lib/audio/input-device.svelte`. This
  // component reads a projection and invokes an action, and it must never call
  // `getUserMedia` or `MediaStreamTrack.stop()` itself.

  import StatusLed from '$lib/ui/controls/StatusLed.svelte';
  import { patch } from '$lib/graph/store';
  import type { ModuleNode } from '$lib/graph/types';
  import { useEngine } from '$lib/audio/engine-context';
  import {
    inputDeviceOptions,
    inputDeviceRoster,
    inputDeviceValue,
    inputMusicMode,
  } from '$lib/audio/input-device.svelte';
  import { nodeAudioInput } from '$lib/ui/modules/node-audio-input-registry.svelte';
  import {
    acquireAudioInput,
    bindAudioInputSurface,
    pickAudioInputDevice,
    releaseAudioInput,
    setAudioInputMusicMode,
  } from './audio-in-actions';
  import {
    inputActionKind,
    inputActionLabel,
    inputFaultLit,
    inputLiveLit,
    inputPickerValueText,
    inputStatusDetail,
  } from './audio-in-status';

  interface Props {
    nodeId: string;
    /** Distinguishes this mount's testids from the module's other surface. */
    testidPrefix: string;
    /** Tile mounts drop the error PROSE — there is no room for a sentence at
     *  192 px, and the full view carries it verbatim. The FAULT lamp still
     *  reports the state and its `title` is that same sentence. */
    compact?: boolean;
  }
  let { nodeId, testidPrefix, compact = false }: Props = $props();

  const engineCtx = useEngine();

  // ── THE MOUNT-SIDE BINDING ────────────────────────────────────────────────
  //
  // ⚠ IN AN `$effect`, NOT AT INIT — `nodeId` is a prop, and reading it at init
  // captures only its first value (svelte-check's `state_referenced_locally`).
  // Re-running is free: every step is idempotent and the unattended acquire is
  // claimed at most once per NODE, in the registry.
  $effect(() => {
    void bindAudioInputSurface(nodeId, engineCtx);
  });

  let node = $derived(patch.nodes[nodeId] as ModuleNode | undefined);
  let view = $derived(nodeAudioInput.view(nodeId));
  let devices = $derived(inputDeviceRoster());
  let options = $derived(inputDeviceOptions(devices));
  let picked = $derived(inputDeviceValue(node));
  let pickedLabel = $derived(options.find((o) => o.value === picked)?.label ?? null);
  let musicMode = $derived(inputMusicMode(node));

  let liveLit = $derived(inputLiveLit(view));
  let faultLit = $derived(inputFaultLit(view));
  let detail = $derived(inputStatusDetail(view));
  let action = $derived(inputActionKind(view));
  let pickerText = $derived(inputPickerValueText(view, devices.length, pickedLabel));

  function onAction(): void {
    if (action === 'stop') releaseAudioInput(nodeId);
    else void acquireAudioInput(nodeId);
  }
</script>

<!-- ⚠ `data-audioin-node` IS AN INSTRUMENT, NOT DECORATION. A rack always holds
     the canvas-hidden `pinned-audioIn`, whose 🎧 tray mount is ALWAYS in the
     document (the panel closes by opacity, never by unmounting) and renders this
     very component with the same testids. So an unscoped `audioin-face-*`
     locator matches at least two elements on every default-shell page and throws
     under Playwright strict mode — and, worse, a spec asserting a surface is
     GONE would be satisfied forever by the pinned one. Scoping by NODE is what
     makes "this node has no mounted surface" expressible at all, which is the
     ACT of the #1590 regression spec. -->
{#snippet devicePicker()}
  <select
    class="device nodrag"
    data-testid="{testidPrefix}-device"
    value={picked ?? ''}
    disabled={options.length === 0}
    aria-label="Audio input device"
    aria-valuetext={pickerText}
    onchange={(e) => pickAudioInputDevice(nodeId, (e.currentTarget as HTMLSelectElement).value)}
  >
    {#if options.length === 0}
      <option value="">(no inputs)</option>
    {:else}
      {#if !picked}
        <option value="" disabled selected>(pick one)</option>
      {/if}
      {#each options as o (o.value)}
        <option value={o.value} selected={o.value === picked}>{o.label}</option>
      {/each}
    {/if}
  </select>
{/snippet}

<!-- ⚠ A REAL `<button>` AND A REAL CLICK. The browser grants a FIRST microphone
     permission only from a genuine activation context, so this gesture can never
     move into an effect — and it must exist on the TILE, which is the whole
     reason this component is shared. Its CAPTION is the gesture's own name
     (ENABLE / RETRY / STOP — permitted face text), and it doubles as the tile's
     statement of whether the input is open. -->
{#snippet actionButton()}
  <button
    type="button"
    class="act nodrag"
    class:stop={action === 'stop'}
    data-testid="{testidPrefix}-action"
    data-action={action ?? 'none'}
    disabled={action === null || options.length === 0}
    title={detail}
    onclick={onAction}
  >{action ? inputActionLabel(action, compact) : '…'}</button>
{/snippet}

{#snippet faultLamp()}
  <StatusLed caption="FAULT" lit={faultLit} tone="warn" {detail} testid="{testidPrefix}-fault" />
{/snippet}

<div
  class="src"
  class:compact
  data-testid="{testidPrefix}-controls"
  data-audioin-node={nodeId}
>
  {#if compact}
    <!-- ⚠ THE LANE TILE IS **ONE ROW**, AND THAT IS A MEASURED CONSTRAINT, not a
         taste call. The shell budgets the tile's height, and the first draft put
         three rows here: the VRT compact baseline came back with the lamps row
         PAINTED OVER the GAIN fader's caption. `cameraInput`'s shipped tile is
         the shape that fits — lamp, picker, gesture, one line — and this is that
         shape.
         WHAT THE TILE DROPS, AND WHY EACH IS SAFE:
           * the LIVE lamp — this face has a live `meter` GLYPH on the same tile,
             so signal presence is already drawn, and the action button's own
             caption says STOP when the input is open. `cameraInput` has no lamp
             pair here either.
           * MUSIC MODE — a set-and-forget capture-DSP switch, not a play
             control. It is one click away in the dock full view, and it is
             ALWAYS present on the pinned instance's 🎧 tray, which is the
             `fullViewBody`.
           * the error PROSE — the `cameraInput` precedent verbatim: there is no
             room for a sentence at 192 px, and the FAULT lamp's `title` carries
             the same sentence.
         WHAT IT KEEPS is the part that cannot live anywhere else: ENABLE is the
         ONLY route to a first `getUserMedia` grant. -->
    <div class="pick-row">
      {@render faultLamp()}
      {@render devicePicker()}
      {@render actionButton()}
    </div>
  {:else}
    <div class="lamps">
      <!-- ⚠ TWO LAMPS, NOT ONE, AND THE SECOND IS NOT DECORATION. `StatusLed`'s
           caption is STATIC by contract, so one lamp cannot distinguish "not
           running because you have not asked" from "not running because the
           browser refused" — and those are the two states a player has to tell
           apart before they can act. LIVE dark + FAULT dark is a rack waiting for
           a click; LIVE dark + FAULT lit is a rack that needs a decision. The
           sentence behind both is the same `detail`, which reaches `aria-label`
           and `title` and never a text node. -->
      <StatusLed caption="LIVE" lit={liveLit} {detail} testid="{testidPrefix}-live" />
      {@render faultLamp()}
    </div>

    <div class="pick-row">
      {@render devicePicker()}
      {@render actionButton()}
    </div>

    <label class="music nodrag" title="Force the browser's echo-cancel / noise-suppress / auto-gain OFF for a clean line-level feed">
      <input
        type="checkbox"
        data-testid="{testidPrefix}-music-mode"
        checked={musicMode}
        onchange={(e) => setAudioInputMusicMode(nodeId, (e.currentTarget as HTMLInputElement).checked)}
      />
      <span>music mode</span>
    </label>

    <!-- ⚠ TRANSIENT, NOT RESTING. This element does not exist unless something
         failed — feedback on a gesture, the shape `audioOut`'s body already ships
         for a rejected `setSinkId`. At rest there is no error and therefore no
         text. `role="alert"` makes the failure an announcement as well as a line. -->
    {#if view.errorMsg}
      <p class="err" role="alert" data-testid="{testidPrefix}-error">{view.errorMsg}</p>
    {/if}
  {/if}
</div>

<style>
  .src {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    min-width: 0;
  }
  .src.compact { gap: 4px; }
  .lamps {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .src.compact .lamps { gap: 7px; }
  .pick-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-width: 0;
  }
  .src.compact .pick-row { gap: 4px; }
  /* ⚠ `flex-basis: 0` AND `width: 0`, NOT `flex: 1 1 auto` — and this is a
     MEASURED fix, not a style preference. The dock's `.faceplate-body` is
     `width: max-content`, and a `<select>`'s intrinsic width is its LONGEST
     OPTION — here the runner's own hardware names. With an `auto` basis this
     body asked the plate for 42 px more than anything drew in, which the
     face-width gate caught as EMPTY PLATE (content 182, body 224, ceiling 40):
     `readFoldGeometry`'s ink measure takes boxes for cells/pictures and text
     RANGES otherwise, and a closed select's `<option>`s have no client rects at
     all, so a picker can inflate the plate while contributing ZERO ink. Its
     sibling `AudioOutOutputBody` has the identical picker and passes only
     because its meter CANVAS is boxy ink that fills the plate; this body has no
     canvas by design (role `status-primitive`), so the picker had to stop
     sizing the plate instead.
     ⚠ IT IS ALSO A DETERMINISM FIX. An `auto` basis makes the faceplate's WIDTH
     a function of the machine's device names, which would put a machine-specific
     number in a committed VRT baseline. */
  .device {
    flex: 1 1 0;
    width: 0;
    min-width: 0;
    font-size: 0.65rem;
    font-family: ui-monospace, monospace;
    padding: 2px 4px;
    background: #151a21;
    color: var(--text);
    border: 1px solid #3a4048;
    border-radius: 3px;
  }
  .src.compact .device { font-size: 0.55rem; padding: 1px 3px; }
  .device:disabled { opacity: 0.45; cursor: not-allowed; }
  .act {
    flex: 0 0 auto;
    font-size: 0.55rem;
    letter-spacing: 0.06em;
    /* ⚠ 3px OF SIDE PADDING, NOT THE 8px THE CAMERA BUTTON USES, AND IT IS A
       MEASURED NUMBER. This button is the WIDEST element in the body, so its
       box is what `.faceplate-body`'s `max-content` resolves to — while the
       dock's face-width gate measures INK as the button's TEXT RANGE. Every
       pixel of side padding here is therefore counted as EMPTY PLATE twice
       over. MEASURED, dock full view: at 8px the face reported 41 px of slack
       against a 40 px ceiling; at 3px it reports 31. The 31 that remains is the
       shell + faceplate chrome every face pays. */
    padding: 2px 3px;
    border: 1px solid var(--cable-audio, var(--border));
    border-radius: 2px;
    background: rgba(34, 197, 94, 0.12);
    color: var(--text);
    cursor: pointer;
    white-space: nowrap;
  }
  .src.compact .act { font-size: 0.5rem; padding: 2px 3px; letter-spacing: 0.04em; }
  .act.stop {
    background: transparent;
    border-color: var(--border);
  }
  .act:hover:not(:disabled) { background: rgba(34, 197, 94, 0.2); }
  .act:disabled { opacity: 0.4; cursor: not-allowed; }
  .act:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  .music {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    cursor: pointer;
  }
  .music input { margin: 0; accent-color: var(--cable-audio, #22c55e); }
  .err {
    margin: 0;
    font-size: 0.6rem;
    color: #fca5a5;
    line-height: 1.3;
    width: 100%;
    min-width: 0;
  }
</style>
