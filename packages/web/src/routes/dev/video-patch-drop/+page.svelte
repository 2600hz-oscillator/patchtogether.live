<script lang="ts">
  // ⛔ MOCKS ONLY — DO NOT MERGE AS IMPLEMENTATION.
  //
  // Rendered mocks for the proposed VIDEO PATCH-DROP paradigm: drag a video
  // faceplate onto another and get a modal that wires them, with Tab inverting
  // which one is upstream.
  //
  // WHY A /dev ROUTE. It is the shipped pattern for exactly this — /dev/xy-pad,
  // /dev/param-grid, /dev/color-field and /dev/glyphs are all component
  // showcases gated on `testHooksEnabled()`, so they survive into the `vite
  // preview` bundle CI runs against and are replaced by a notice in a real prod
  // build. It costs no engine change, the owner can open it on a dev server,
  // and — the reason it beats a PNG or a Storybook — the scenes are the REAL
  // components against the REAL defs, so a VRT spec can point a camera at this
  // URL and adopt the result as a baseline without anything being rebuilt.
  //
  // ⚠ ADOPTION IS ONE STEP, AND IT IS NOT DONE HERE. VRT visits only `/` and
  // `/rack` today, and its spec set is a hard-coded array — a new spec must be
  // added to FULL_MATCH (and STRICT_MATCH to gate merges) in e2e/vrt/vrt.config.ts
  // or it never runs. Deliberately not done: capturing baselines for a design
  // that has not been approved would pin the wrong picture and cost a 37–54 min
  // linux capture to unpin. The scenes are built to be capture-ready — fixed
  // widths, no animation, no live video, stable testids — so adoption is
  // "write the spec", not "rebuild the page".
  import { onMount } from 'svelte';
  import { testHooksEnabled } from '$lib/dev/test-hooks';
  import DropPatchModal from '$lib/dev/video-patch-drop/DropPatchModal.svelte';
  import { buildDropPlan, type DropDefLike } from '$lib/dev/video-patch-drop/drop-plan';

  // REAL defs, imported directly rather than through the registry so a scene
  // cannot silently render a placeholder if registration order changes.
  import { backdraftDef } from '$lib/video/modules/backdraft';
  import { cameraInputDef } from '$lib/video/modules/camera-input';
  import { colorizerDef } from '$lib/video/modules/colorizer';
  import { colourofmagicDef } from '$lib/video/modules/colourofmagic';
  import { edgesDef } from '$lib/video/modules/edges';
  import { peakstateDef } from '$lib/video/modules/peakstate';

  const isDev = testHooksEnabled();

  // HYDRATION SIGNAL — the /dev/xy-pad precedent. These routes are
  // server-rendered, so a scene is painted a beat before Svelte attaches; a
  // capture or a keystroke in that window sees a half-live page.
  let hydrated = $state(false);
  onMount(() => {
    hydrated = true;
  });

  const defs = {
    backdraft: backdraftDef as unknown as DropDefLike,
    camera: cameraInputDef as unknown as DropDefLike,
    colorizer: colorizerDef as unknown as DropDefLike,
    colourofmagic: colourofmagicDef as unknown as DropDefLike,
    edges: edgesDef as unknown as DropDefLike,
    peakstate: peakstateDef as unknown as DropDefLike,
  };

  /** What `findRepair` may search. Passed in rather than read off the registry
   *  so a scene's suggestion is reproducible for a capture. */
  const repairCandidates: DropDefLike[] = [defs.colourofmagic, defs.edges];

  // The numbers quoted in the prose are DERIVED from the same plan the scene
  // renders, so a def change moves the picture and the sentence together.
  const backdraftOnCamera = buildDropPlan(
    { nodeId: 'backdraft-1', def: defs.backdraft },
    { nodeId: 'camera-1', def: defs.camera },
    'downstream',
  );
  const cameraSubset = backdraftOnCamera.subset;
  const comOuts = (defs.colourofmagic.outputs ?? []).length;
  const comVideoOuts = buildDropPlan(
    { nodeId: 'x', def: defs.backdraft },
    { nodeId: 'com-1', def: defs.colourofmagic },
    'upstream',
  ).carriable.length;
  const RAIL_DOT_CAP = 4; // mirrors PatchPanel's lane-rail preview cap
</script>

<svelte:head><title>video patch-drop — mocks</title></svelte:head>

{#if !isDev}
  <p class="notice">
    This dev-only showcase is disabled in production builds. Run a dev server, or build with
    <code>VITE_E2E_HOOKS=1</code>.
  </p>
{:else}
  <main class="page" data-testid="video-patch-drop-mocks" data-hydrated={hydrated}>
    <header class="hero">
      <p class="stamp">mocks only — do not merge as implementation</p>
      <h1>video patch-drop</h1>
      <p class="lede">
        Drag a video faceplate onto another and drop it. A modal opens showing how the two can be
        wired. <kbd>tab</kbd> inverts which module is upstream. Every panel below is the real
        <code>&lt;RearCard&gt;</code> against the real module def — the compatibility of each hole
        is computed by the shipped
        <code>canConnectToPort</code>, not drawn.
      </p>
    </header>

    <!-- 1 ─────────────────────────────────────────────────────────────── -->
    <section class="scene" data-testid="scene-default">
      <div class="scene-head">
        <h2><span class="n">1</span> the default direction</h2>
        <p>
          The owner's example: drop <b>backdraft</b> onto <b>camera</b>. The dropped module lands
          <i>downstream</i>, so camera's out feeds backdraft's ins — all
          {cameraSubset.shownInputs} of them, offered at once. That is the whole point: this patch
          currently costs a drill-down per cable.
        </p>
      </div>
      <p class="live-note">
        ⚠ This scene is <b>live</b>: it claims the real
        <code>connectDragState</code> carry, so the backpanel below is showing the shipped
        <b>compatibility dim</b> — the four video holes lit, the 29 CV holes and the output rail
        dropped to ~35%. Nothing in the mock colours a hole; <code>RearCard</code> is answering for
        itself. Press <kbd>tab</kbd> with the page focused to invert it.
      </p>
      <DropPatchModal
        dropped={{ nodeId: 'backdraft-1', def: defs.backdraft }}
        onto={{ nodeId: 'camera-1', def: defs.camera }}
        direction="downstream"
        live
        {repairCandidates}
      />
    </section>

    <!-- 2 ─────────────────────────────────────────────────────────────── -->
    <section class="scene" data-testid="scene-inverted">
      <div class="scene-head">
        <h2><span class="n">2</span> tab — inverted</h2>
        <p>
          Same drop, <kbd>tab</kbd> pressed. Now backdraft is upstream and camera is receiving —
          and camera declares <b>no video inputs at all</b>, so this direction has nowhere to land.
          <b>The modal says so rather than refusing to flip.</b> An inversion that silently did
          nothing would be indistinguishable from a dropped keystroke, and this is the state a user
          passes through on the way to the other one.
        </p>
      </div>
      <DropPatchModal
        dropped={{ nodeId: 'backdraft-1', def: defs.backdraft }}
        onto={{ nodeId: 'camera-1', def: defs.camera }}
        direction="upstream"
        tabPressed
        {repairCandidates}
      />
    </section>

    <!-- 3 ─────────────────────────────────────────────────────────────── -->
    <section class="scene" data-testid="scene-feedback">
      <div class="scene-head">
        <h2><span class="n">3</span> the feedback loop, in two tab presses</h2>
        <p>
          <b>backdraft 2</b> dropped on <b>backdraft 1</b>. Both directions are populated, so the
          flip is symmetric — and this is the case the gesture exists for. Patch
          <code>1.OUT → 2.IN_A</code> in the default view, press <kbd>tab</kbd>, patch
          <code>2.OUT → 1.IN_B</code>, and the loop is closed without the modal ever closing.
          Committed rows survive the flip (shown <b>patched</b> below), which is what makes the
          second half of the loop legible as part of the same gesture.
        </p>
      </div>
      <div class="pair">
        <div class="pair-cell">
          <p class="pair-cap">before tab — 1 feeds 2</p>
          <DropPatchModal
            dropped={{ nodeId: 'backdraft-2', def: defs.backdraft, label: 'backdraft #2' }}
            onto={{ nodeId: 'backdraft-1', def: defs.backdraft, label: 'backdraft #1' }}
            direction="downstream"
            committed={['backdraft-1.out→backdraft-2.in_a']}
            {repairCandidates}
          />
        </div>
        <div class="pair-cell">
          <p class="pair-cap">after tab — 2 feeds 1, first leg still shown</p>
          <DropPatchModal
            dropped={{ nodeId: 'backdraft-2', def: defs.backdraft, label: 'backdraft #2' }}
            onto={{ nodeId: 'backdraft-1', def: defs.backdraft, label: 'backdraft #1' }}
            direction="upstream"
            tabPressed
            committed={['backdraft-1.out→backdraft-2.in_a', 'backdraft-2.out→backdraft-1.in_b']}
            {repairCandidates}
          />
        </div>
      </div>
    </section>

    <!-- 4 ─────────────────────────────────────────────────────────────── -->
    <section class="scene" data-testid="scene-typing">
      <div class="scene-head">
        <h2><span class="n">4</span> the typing rule, made visible</h2>
        <p>
          <b>mono → colour is free; colour → mono is refused.</b> Left: drop <b>backdraft</b> onto
          <b>peakstate</b>, whose <code>MONO_OUT</code> is <code>mono-video</code> — it widens into
          every one of backdraft's colour ins, no ceremony. Right: drop <b>colorizer</b> onto
          <b>camera</b>. Colorizer's only video in is <code>mono-video</code> and camera emits
          <code>video</code>, so the row is <b>refused</b> — greyed, still readable, with the reason
          and the repair.
        </p>
      </div>
      <div class="pair">
        <div class="pair-cell">
          <p class="pair-cap">mono out → colour ins — offered</p>
          <DropPatchModal
            dropped={{ nodeId: 'backdraft-1', def: defs.backdraft }}
            onto={{ nodeId: 'peakstate-1', def: defs.peakstate }}
            direction="downstream"
            carriedPortId="mono_out"
            {repairCandidates}
          />
        </div>
        <div class="pair-cell">
          <p class="pair-cap">colour out → mono in — refused, with the way out</p>
          <DropPatchModal
            dropped={{ nodeId: 'colorizer-1', def: defs.colorizer }}
            onto={{ nodeId: 'camera-1', def: defs.camera }}
            direction="downstream"
            {repairCandidates}
          />
        </div>
      </div>

      <div class="callout" data-testid="refusal-recommendation">
        <h3>recommendation — a refusal should be <em>dimmed and explained</em>, never hidden</h3>
        <p>
          Three options were on the table: hide the row, disable it, or explain it. <b>Hiding is
          the one to avoid.</b> A hidden row and a module that simply does not have that jack look
          identical, so the user cannot tell "you may not" from "there is nothing there" — and this
          modal is opened precisely by someone who does not yet know a module's ports. It also makes
          the rule unlearnable: nobody infers a type lattice from an absence.
        </p>
        <p>
          Dimming is also what the product already does. <code>RearCard</code> ships a compatibility
          dim (<code>data-compat="dim"</code>) that drops incompatible holes to ~35% while a cable is
          carried, rather than removing them. The modal should read the same way, so one rule is
          taught in one visual language.
        </p>
        <p>
          The addition worth making is the <b>repair</b>. A refusal that names its axis can name its
          own fix: colour-into-mono needs a reduction, and the app already contains modules that
          reduce. Offering "insert <b>colour of magic</b> ▸ <code>luma</code>" turns a dead end into
          one click. That suggestion is <i>derived</i> — <code>findRepair</code> searches defs for
          any module that accepts the carried cable and emits something the refused input takes — so
          a new reducer becomes an offered repair the day it lands, with nobody maintaining a list
          of converters.
        </p>
      </div>
    </section>

    <!-- 5 ─────────────────────────────────────────────────────────────── -->
    <section class="scene" data-testid="scene-subset">
      <div class="scene-head">
        <h2><span class="n">5</span> the "subset of video outs" problem</h2>
        <p>
          Two different things wear that name, and only one of them is a bug.
        </p>
      </div>

      <div class="callout" data-testid="subset-explanation">
        <h3>(a) the real truncation — the lane rail shows the first {RAIL_DOT_CAP}, positionally</h3>
        <p>
          <code>PatchPanel.svelte</code> computes
          <code>railOutputs = allOutputs.slice(0, RAIL_DOT_CAP)</code> with
          <code>RAIL_DOT_CAP = {RAIL_DOT_CAP}</code>, then a measured fit narrows it further —
          and outputs are allotted only the slots inputs did not take, so
          <b>on a port-heavy module the outs are the first thing to vanish entirely</b>.
          <b>colour of magic</b> declares <b>{comOuts}</b> outputs and the rail can show
          {RAIL_DOT_CAP}. Which {RAIL_DOT_CAP} is decided by <i>declaration order</i>, not by
          usefulness — its {comOuts - comVideoOuts + comVideoOuts - 6} mono channel taps
          (<code>LUMA</code>, <code>R</code>, <code>G</code>, <code>B</code> …) all sit past the cap.
        </p>
        <p>
          <b>The fix is to not inherit the rail's cut.</b> The rear card already renders
          <i>every</i> declared port with no elision — that is stated in
          <code>rear-card-model.ts</code> — so a modal built on the rear-card model is complete by
          construction. The panels below are exactly that.
        </p>

        <h3>(b) the deliberate filter — video ports only</h3>
        <p>
          The owner's "we only need to consider video ins and outs" is a filter this modal
          <i>should</i> apply: it is what turns backdraft's <b>33</b> inputs into the
          <b>{cameraSubset.shownInputs}</b> that matter for a video drop. But a filter that hides
          silently re-creates the problem it solved, so every scene above <b>states its own
          omission</b> — "{cameraSubset.hiddenCvInputs} cv hidden" — and offers to drop it.
          ⚠ Those CV inputs are not decorative: <code>canConnect('cv', &lt;any video type&gt;)</code>
          is <code>true</code>, so a CV out really can reach a video-typed in. "Video ports" and
          "ports that can carry this patch" are different sets, and the modal must not conflate
          them.
        </p>
      </div>

      <div class="pair">
        <div class="pair-cell">
          <p class="pair-cap">
            colour of magic receiving — the rear model, all {comOuts} outs present
          </p>
          <DropPatchModal
            dropped={{ nodeId: 'com-1', def: defs.colourofmagic }}
            onto={{ nodeId: 'camera-1', def: defs.camera }}
            direction="upstream"
            {repairCandidates}
          />
        </div>
        <div class="pair-cell">
          <p class="pair-cap">…and a port whose own <code>accepts</code> widens the rule</p>
          <DropPatchModal
            dropped={{ nodeId: 'com-1', def: defs.colourofmagic }}
            onto={{ nodeId: 'camera-1', def: defs.camera }}
            direction="downstream"
            {repairCandidates}
          />
        </div>
      </div>
    </section>

    <!-- notes ─────────────────────────────────────────────────────────── -->
    <section class="scene" data-testid="scene-notes">
      <div class="scene-head"><h2><span class="n">·</span> notes for the build</h2></div>

      <div class="callout">
        <h3>tab: a third owner, arbitrated the way the two existing owners already are</h3>
        <p>
          Tab is the flip gesture (owner ruling <b>#1629</b>) and must stay so. There is no conflict
          to resolve, because the app <i>already</i> has two Tab owners and a rule for choosing
          between them: <b>occupancy</b>. The dock claims Tab while a full-view pane is open
          (<code>fullViewNodeIds.length &gt; 0</code>); the canvas-wide rear-view flip claims it
          only when that is empty. Both are plain <code>window</code> listeners, so
          <code>preventDefault</code> in one does not stop the other — the guard, not the event, is
          what makes exactly one act.
        </p>
        <p>
          The drop modal becomes the <b>innermost</b> owner on the same principle, and the metaphor
          survives intact: at every level Tab means <i>show me the reverse side</i> — the back of a
          card, or the other direction of a patch.
        </p>
        <p class="warn">
          ⚠ <b>The finding.</b> Each owner's guard is written independently and names the others by
          hand (the canvas hard-codes <code>fullViewNodeIds.length === 0</code>). Adding a third
          means editing every existing guard, and <b>nothing fails loudly if you forget</b> — the
          symptom is two handlers firing on one keystroke and two flip states phase-diverging, which
          is a bug this codebase has already had once and fixed by hand. Before adding an owner,
          replace the pairwise guards with one <code>flipKeyOwner()</code> resolver that returns the
          innermost claimant, so a new surface <i>registers</i> instead of every existing surface
          learning about it.
        </p>
        <p class="warn">
          ⚠ Related, and already live: the sequencer cards (<code>SequencerCard</code>,
          <code>PolyseqzCard</code>, <code>DrumseqzCard</code>, <code>CartesianCard</code>) handle
          Tab on their step buttons without <code>stopPropagation</code>, so the window flip handler
          fires on the same keystroke — Tab advances the step <i>and</i> flips the rack.
        </p>
      </div>

      <div class="callout">
        <h3>the compatibility predicate, and the gap it closes</h3>
        <p>
          The mono/colour rule the owner asked for <b>is already derived</b> — it is not a list of
          module names anywhere. <code>canConnect</code> permits <code>mono-video → video</code> and
          refuses the reverse. What is a list is the <i>shape</i>: a hand-written table of upcast
          edges, which has to be transitively closed by hand and <b>is not</b>.
        </p>
        <p>
          The four video types are two independent axes — <b>channels</b> (mono ⊑ colour) and
          <b>motion</b> (still ⊑ animated) — and the union's own comment says so. Compatibility is
          the product order over those axes, which is transitively closed by construction. Measured
          against the shipped rule over all 16 ordered pairs, the derived predicate agrees on
          everything except one: <code>keys → video</code>, the diagonal the edge table never wrote
          down.
        </p>
        <p class="warn">
          ⚠ No port in the repo is typed <code>keys</code>, so the gap looks free. It is not:
          backdraft's two <b>key-mask</b> inputs are declared <code>video</code> with the def saying
          why — <i>"'video' so any source (LINES / SHAPES / a key) patches in"</i>. The type rule did
          not just refuse a patch; it bent a contract around itself, and every gate that reads that
          contract now reads the bent version. <code>mapper.key</code> is the same.
        </p>
        <p class="warn">
          ⚠ <b>The direction asymmetry.</b> <code>compatibleTargetPorts</code> honours a port's
          <code>accepts</code> widening when the source is an OUTPUT but <b>drops it</b> when the
          source is an INPUT — the port descriptor is gone by then, so its <code>accepts</code>
          cannot be consulted. Measured: a <code>mono-video</code> input declaring
          <code>accepts: ['keys','image','video']</code> takes a dragged <code>video</code> cable,
          but starting from that same input offers <b>zero</b> sources. Tab is a gesture for flipping
          between exactly these two directions, so it would make a latent inconsistency into a
          user-visible one. <code>rearHoleAcceptsCarry</code> already gets this right; only the
          cascade disagrees.
        </p>
      </div>

      <div class="callout" data-testid="not-captured">
        <h3>what these mocks do NOT capture</h3>
        <ul>
          <li>
            <b>The drag itself.</b> No card-onto-card drag exists in the app — the only node-drag
            handler is <code>onnodedragstop</code>, used for workflow-lane membership. The nearest
            precedent is the <i>cable</i> drop-on-card
            (<code>hoveredCardNodeId</code> → <code>openDrillDownForCarry</code>). Hit-testing,
            the drop-shadow/hover affordance, what happens when you drop on empty canvas, and how
            this interacts with lane membership on <code>onnodedragstop</code> are all undesigned.
          </li>
          <li>
            <b>Commit.</b> Rows show a <code>patched</code> state but nothing writes an edge.
            Undo grouping (is a modal session one undo step?), overwrite of an occupied input, and
            the destructive-overwrite warning the cascade already shows are not modelled.
          </li>
          <li>
            <b>More than one carried out at a time.</b> The modal carries one output; a 4-in / 4-out
            pair still needs four passes. Multi-select and an "auto-wire" default were not explored.
          </li>
          <li>
            <b>Audio/CV.</b> The predicate is written to extend, and the CV family falls out of it,
            but no audio scene is rendered and <code>modsignal</code>/<code>polyPitchGate</code> are
            modelled as adapters on paper only. ⚠ Note <code>pitch → modsignal</code> is refused
            today while <code>cv →</code> and <code>gate → modsignal</code> are allowed, though all
            three are declared freely interchangeable — adopting a derived rule forces a decision
            there.
          </li>
          <li>
            <b>Stereo collapse.</b> <code>collapseStereoPorts</code> is a no-op for video (no video
            def declares <code>stereoPairs</code>) so the scenes never exercise it. An audio
            extension would.
          </li>
          <li>
            <b>Real pixels in the panels.</b> <code>RearCard</code> renders against an empty patch
            store, so every hole reads unpatched and no endpoint chips appear. A real drop happens
            between two modules that usually already have cables.
          </li>
          <li>
            ⚠ <b>One carry, eight panels.</b> <code>connectDragState</code> is a global singleton,
            so only scene 1 is <code>live</code> and <i>every</i> backpanel on this page dims
            against <i>its</i> carried cable rather than its own scene's. It happens to agree
            everywhere here — the carried cable is <code>video</code> and the one scene carrying
            <code>mono-video</code> targets all-<code>video</code> inputs, which answer the same —
            but the panels are not independently correct, and a scene added later could disagree
            with its own row list without anything complaining.
          </li>
          <li><b>Responsive / small-viewport layout, and the light theme.</b></li>
        </ul>
      </div>
    </section>
  </main>
{/if}

<style>
  .notice {
    margin: 40px auto;
    max-width: 40rem;
    font: 14px/1.6 ui-monospace, monospace;
    color: #888;
    text-align: center;
  }

  .page {
    --pg-bg: #0e1014;
    --pg-fg: #dfe3ea;
    --pg-dim: #8b93a3;
    --pg-line: #262a33;
    --pg-warn: #e8b04b;
    box-sizing: border-box;
    min-height: 100vh;
    margin: 0;
    padding: 28px 32px 64px;
    background: var(--pg-bg);
    color: var(--pg-fg);
    font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .page :global(*) {
    box-sizing: border-box;
  }

  .hero {
    max-width: 62rem;
    margin: 0 0 34px;
  }
  .stamp {
    display: inline-block;
    margin: 0 0 12px;
    padding: 3px 10px;
    border: 1px solid #7a3b3b;
    border-radius: 3px;
    background: #2a1618;
    color: #e0645f;
    font-size: 10px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }
  h1 {
    margin: 0 0 10px;
    font-size: 26px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  .lede {
    margin: 0;
    max-width: 58rem;
    color: var(--pg-dim);
  }

  .live-note {
    max-width: 62rem;
    margin: 0 0 12px;
    padding: 8px 10px;
    border: 1px solid #2f4a3a;
    border-radius: 4px;
    background: #141d18;
    color: #93b6a2;
    font-size: 11px;
  }
  .live-note b {
    color: #cfe8da;
    font-weight: 500;
  }

  .scene {
    margin: 0 0 40px;
    padding: 0 0 34px;
    border-bottom: 1px solid var(--pg-line);
  }
  .scene:last-child {
    border-bottom: none;
  }
  .scene-head {
    max-width: 62rem;
    margin: 0 0 14px;
  }
  h2 {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin: 0 0 8px;
    font-size: 16px;
    font-weight: 500;
  }
  h2 .n {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: 1px solid var(--pg-line);
    border-radius: 50%;
    font-size: 11px;
    color: var(--pg-dim);
  }
  .scene-head p {
    margin: 0;
    color: var(--pg-dim);
  }
  .scene-head b,
  .callout b {
    color: var(--pg-fg);
    font-weight: 500;
  }

  .pair {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(430px, 1fr));
    gap: 18px;
    align-items: start;
  }
  .pair-cell {
    min-width: 0;
  }
  .pair-cap {
    margin: 0 0 6px;
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--pg-dim);
  }

  .callout {
    max-width: 62rem;
    margin: 18px 0 0;
    padding: 14px 16px;
    border: 1px solid var(--pg-line);
    border-left: 2px solid #46506a;
    border-radius: 5px;
    background: #13161c;
  }
  .callout h3 {
    margin: 0 0 8px;
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  .callout h3 + p,
  .callout p + h3 {
    margin-top: 10px;
  }
  .callout p {
    margin: 0 0 8px;
    color: var(--pg-dim);
  }
  .callout p:last-child {
    margin-bottom: 0;
  }
  .callout ul {
    margin: 0;
    padding-left: 18px;
    color: var(--pg-dim);
  }
  .callout li {
    margin-bottom: 7px;
  }
  .callout li:last-child {
    margin-bottom: 0;
  }
  .warn {
    padding: 8px 10px;
    border-radius: 4px;
    background: #1c1a13;
    color: #c9ba92 !important;
  }
  .warn b {
    color: var(--pg-warn) !important;
  }

  code {
    padding: 0 3px;
    border-radius: 2px;
    background: #1c2028;
    color: #a8c8e8;
    font-size: 0.94em;
  }
  kbd {
    display: inline-block;
    padding: 1px 5px;
    border: 1px solid var(--pg-line);
    border-bottom-width: 2px;
    border-radius: 3px;
    background: #1c2028;
    font-size: 0.85em;
  }
  em {
    font-style: normal;
    color: var(--pg-fg);
  }
</style>
