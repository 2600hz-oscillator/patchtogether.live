<script lang="ts">
  // packages/web/src/lib/ui/modules/scope/ScopeTraceSurface.svelte
  //
  // THE scope trace, extracted from `ScopeCard.svelte` so every surface that
  // shows one paints the SAME picture from the SAME code — the legacy card and
  // the dock faceplate body. (There was a THIRD host, `GroupCard`'s
  // viz-passthrough mount, and it is what forced the extraction; it went with
  // the GROUP! module.)
  //
  // ⚠ WHY IT EXISTS, and it is not "three copies were untidy". The card and
  // `ScopeScreenBody` each carried their own `vrtSeed` / `seededSnapshot` /
  // `paint` trio — one pasted from the other, agreeing exactly because of that,
  // which is the condition under which two implementations stop agreeing
  // silently. The third consumer is what forced the issue: `GroupCard` mounted
  // the whole REAL `ScopeCard` (hidden, `display:none`) purely to get a live
  // `<canvas data-viz-passthrough>` it could portal into a collapsed group's
  // body — the last edge tying an ORGANIZATIONAL container to a module card,
  // which is why the group needed something that was not a card to mount.
  //
  // ⚠ THAT CONSUMER NO LONGER EXISTS (GROUP! deleted, 2026-09-04), AND THE FILE
  // STAYS ANYWAY. Two hosts still share it, and "two copies pasted from each
  // other" is exactly the condition this extraction removed. The
  // `vizPassthrough` PROP is gone with its only `true` caller, so this surface
  // no longer emits `data-viz-passthrough` at all.
  //
  // ⚠ IT PAINTS; IT PRODUCES NOTHING. The cvCombined push that used to ride this
  // loop belongs to the NODE now (`$lib/ui/media/frame-producers` —
  // SCOPE_FRAME_PRODUCER), because it is engine-visible state every consumer of
  // the module sees and it must run while the node exists, not while a surface
  // does. Nothing in this file writes to the engine, and that is the property
  // that lets `scope` leave `CARD_PRODUCER_LANE_TYPES`. Do not re-add a push
  // here to "make the picture agree" — the picture reads `read('drawParams')`,
  // which is the same shadow the producer fills and `drawFrame` renders `out`
  // from.
  //
  // ⚠ AND DO NOT SPELL THE SEAM CALL-SHAPED IN A COMMENT ANYWHERE IN A CARD'S
  // SUBTREE. The producer gate matches its seam regexes against RAW source and
  // strips no comments, so a call-shaped mention here enrols `scope` (through
  // `ScopeCard`) into `CARD_PRODUCER_LANE_TYPES`. (It used to enrol `group`
  // too, through `GroupCard` — a container with no engine state at all — which
  // is the sharpest version of why this rule exists.)
  //
  // ⚠ IT RENDERS EXACTLY ONE ELEMENT — the <canvas>, with no wrapper. The card
  // mounts it as the only child of `.screen-wrap` and that layout is VRT-pinned,
  // so a wrapper div here would move a baseline. Sizing CSS therefore stays with
  // each HOST (`:global(canvas)` under its own scoped ancestor), because the
  // three hosts want three different boxes for one bitmap.
  //
  // ⚠ `onMeterFrame`, NOT A RAW rAF — the convention both former call sites
  // used, and the right one for a PAINT: it is IntersectionObserver-gated, so a
  // trace scrolled out of view stops repainting. That gate would be wrong for a
  // producer (a scrolled-away tile must keep feeding its downstream chain) and
  // is exactly why the producer is not here.
  import { onMount } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { onMeterFrame } from '$lib/ui/meter-frame';
  import { useEngine } from '$lib/audio/engine-context';
  import { scopeDef, type ScopeSnapshot } from '$lib/audio/modules/scope';
  import { drawScope, type ScopeTuning } from '$lib/audio/modules/scope-draw';
  import type { ModuleNode } from '$lib/graph/types';

  interface Props {
    /** The graph node this trace is drawn for. */
    nodeId: string;
    /** Backing-store size of the canvas, in device px. */
    width?: number;
    height?: number;
    /** `data-testid` on the canvas — each host names its own. */
    testid?: string;
    /**
     * The tuning graticule `drawScope` annotates the trace with — note letter
     * and cents. Only the faceplate body supplies it; the card's readout row is
     * a separate DOM element (see its own comments).
     */
    tuning?: ScopeTuning | null;
  }
  let {
    nodeId,
    width = 320,
    height = 300,
    testid = 'scope-canvas',
    tuning = null,
  }: Props = $props();

  const engineCtx = useEngine();

  // Read from the STORE, not from a `data.node` prop. The headless/producer
  // paths have no NodeProps at all (and `GroupCard`, while it existed, mounted
  // this for a CHILD node it synthesized props for); one lookup answers for
  // every host. The draw loop
  // reads it imperatively, so an identity-stale SyncedStore proxy still yields
  // live values (`yjs-proxy-stable-identity-defeats-derived`).
  let node = $derived(patch.nodes[nodeId] as ModuleNode | undefined);

  /** Every param's shipped default, keyed BY ID.
   *
   *  ⚠ BY ID RATHER THAN BY INDEX, and that is not style. `ScopeCard.svelte`
   *  read its fallbacks as `scopeDef.params[4]!.defaultValue` — nine positional
   *  literals that are silently wrong the day anyone reorders the array, and
   *  wrong in the worst way (a plausible number from the neighbouring control,
   *  not a crash). Keying by id cannot drift. */
  const DEFAULTS: Record<string, number> = Object.fromEntries(
    scopeDef.params.map((p) => [p.id, p.defaultValue]),
  );

  /** Knob fallbacks — what the trace draws with before an engine exists. With
   *  nothing patched these equal the combined values anyway. */
  function knob(id: string): number {
    return (node?.params?.[id] as number | undefined) ?? DEFAULTS[id]!;
  }

  // Trace colours: the cable tints, resolved post-mount so they track the theme.
  // ⚠ `onMount`, NOT `$effect`, and deliberately — an effect here would READ
  // each colour in its own `||` fallback and WRITE it, so it would depend on the
  // state it assigns. It converges (Svelte stops on an equal write) but it is a
  // self-referencing effect for a one-shot read of a CSS custom property.
  let ch1Color = $state('#fbbf24');
  let ch2Color = $state('#60a5fa');
  onMount(() => {
    const cs = getComputedStyle(document.documentElement);
    ch1Color = cs.getPropertyValue('--cable-audio').trim() || ch1Color;
    ch2Color = cs.getPropertyValue('--cable-pitch').trim() || ch2Color;
  });

  // ⚠ THE VRT SEED, IN ONE PLACE FOR ALL THREE HOSTS. Two live oscillators
  // driving ch1/ch2 are NOT phase-locked, so a Lissajous figure's orientation
  // drifts run-to-run and any baseline over this canvas would be noise.
  // `__scopeVrtSeed` swaps the live analyser windows for fixed phase-locked
  // sines. Reading a DIFFERENT global per surface would leave one of them
  // unbaselinable while the others stayed pinned — dockscope records that trap
  // by name. No-op in production (the global is never set).
  function vrtSeed(): { ch1Freq: number; ch2Freq: number; ch2Phase?: number } | null {
    const s = (globalThis as unknown as {
      __scopeVrtSeed?: { ch1Freq?: number; ch2Freq?: number; ch2Phase?: number } | boolean;
    }).__scopeVrtSeed;
    if (!s) return null;
    const cfg = typeof s === 'object' ? s : {};
    return { ch1Freq: cfg.ch1Freq ?? 220, ch2Freq: cfg.ch2Freq ?? 330, ch2Phase: cfg.ch2Phase ?? 0 };
  }
  function seededSnapshot(seed: { ch1Freq: number; ch2Freq: number; ch2Phase?: number }): ScopeSnapshot {
    const n = 2048;
    const sampleRate = 48000;
    const ch1 = new Float32Array(n);
    const ch2 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      ch1[i] = Math.sin((2 * Math.PI * seed.ch1Freq * i) / sampleRate);
      ch2[i] = Math.sin((2 * Math.PI * seed.ch2Freq * i) / sampleRate + (seed.ch2Phase ?? 0));
    }
    return { ch1, ch2, sampleRate };
  }

  let canvasEl: HTMLCanvasElement | null = $state(null);

  function paint(c: HTMLCanvasElement, snap: ScopeSnapshot, live?: Record<string, number>): void {
    const ctx2d = c.getContext('2d');
    if (!ctx2d) return;
    drawScope(
      ctx2d,
      snap,
      {
        timeMs: live?.timeMs ?? knob('timeMs'),
        ch1Scale: live?.ch1Scale ?? knob('ch1Scale'),
        ch1Offset: live?.ch1Offset ?? knob('ch1Offset'),
        ch1Range: live?.ch1Range ?? knob('ch1Range'),
        ch2Scale: live?.ch2Scale ?? knob('ch2Scale'),
        ch2Offset: live?.ch2Offset ?? knob('ch2Offset'),
        ch2Range: live?.ch2Range ?? knob('ch2Range'),
        mode: live?.mode ?? knob('mode'),
        intensity: live?.intensity ?? knob('intensity'),
        ch1Color,
        ch2Color,
        ...(tuning ? { tuning } : {}),
      },
      c.width,
      c.height,
    );
  }

  $effect(() => {
    if (!canvasEl) return;
    const h = onMeterFrame(canvasEl, () => {
      const c = canvasEl;
      const n = node;
      if (!c || !n) return;
      const eng = engineCtx.get();
      // READ ONLY. `drawParams` is the module's combined (knob + CV) record —
      // the same shadow `$lib/ui/media/frame-producers` fills once per frame and
      // the same one the cross-domain `drawFrame` renders `out` from, so this
      // canvas and the video output cannot disagree (#1664).
      const live = eng ? (eng.read(n, 'drawParams') as Record<string, number> | undefined) : undefined;
      const seed = vrtSeed();
      const snap = seed
        ? seededSnapshot(seed)
        : (eng?.read(n, 'snapshot') as ScopeSnapshot | undefined);
      if (snap) paint(c, snap, live);
    });
    return () => h.stop();
  });
</script>

<canvas
  bind:this={canvasEl}
  {width}
  {height}
  data-testid={testid}
  data-node-id={nodeId}
></canvas>
