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
  import DropPatchModal from '$lib/ui/patch-drop/DropPatchModal.svelte';
  import { buildDropPlan, type DropDefLike } from '$lib/ui/patch-drop/drop-plan';

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
  const cameraCensus = backdraftOnCamera.census;
  const comOuts = (defs.colourofmagic.outputs ?? []).length;
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

    <!-- 0 ─── IT IS IN THE REAL RACK NOW ────────────────────────────── -->
    <section class="scene" data-testid="scene-shipped">
      <div class="scene-head">
        <h2><span class="n">0</span> the gesture is on the rack — not here</h2>
        <p>
          <b>Go to <code>/rack</code> and drag one module card onto another.</b> Real cards, real
          defs, real committed edges. This page is now only the design record: the scenes below are
          the same <code>&lt;DropPatchModal&gt;</code> the rack opens, mounted against real defs so
          the type rule and the collapse can be read without setting up a patch.
        </p>
        <p class="warn">
          ⚠ The standalone sandbox that used to live here <b>has been deleted</b>. It was a second
          implementation of the same gesture against fake cards, and the owner's verdict on it was
          exactly right — there was nothing to test. Two implementations of one interaction is a
          divergence waiting to happen, so there is now only one.
        </p>
      </div>
    </section>

    <!-- 1 ─────────────────────────────────────────────────────────────── -->
    <section class="scene" data-testid="scene-default">
      <div class="scene-head">
        <h2><span class="n">1</span> the default direction</h2>
        <p>
          The owner's example: drop <b>backdraft</b> onto <b>camera</b>. The dropped module lands
          <i>downstream</i>, so camera's out feeds backdraft's ins — all
          {cameraCensus.offeredInputs} of them, offered at once. That is the whole point: this patch
          currently costs a drill-down per cable. The other
          {cameraCensus.refusedInputs} declared inputs are behind the
          <b>"{cameraCensus.refusedInputs} not compatible"</b> row — collapsed, but there.
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

        rearOpen
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

        rearOpen
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

            rearOpen
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

            rearOpen
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

            rearOpen
          />
        </div>
        <div class="pair-cell">
          <p class="pair-cap">colour out → mono in — refused, with the way out</p>
          <DropPatchModal
            dropped={{ nodeId: 'colorizer-1', def: defs.colorizer }}
            onto={{ nodeId: 'camera-1', def: defs.camera }}
            direction="downstream"

            rearOpen
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
          usefulness — its mono channel taps
          (<code>LUMA</code>, <code>R</code>, <code>G</code>, <code>B</code> …) all sit past the cap.
        </p>
        <p>
          <b>The fix is to not inherit the rail's cut.</b> The rear card already renders
          <i>every</i> declared port with no elision — that is stated in
          <code>rear-card-model.ts</code> — so a modal built on the rear-card model is complete by
          construction. The panels below are exactly that.
        </p>

        <h3>(b) the deliberate filter — REPLACED, in this round, by the collapse</h3>
        <p>
          The owner's "we only need to consider video ins and outs" was implemented last round as a
          <b>domain filter</b>. It has been removed, and the reason is a measurement: across every
          ordered pair of these six modules the <i>refused-row</i> count peaks at <b>one</b>. The
          large data the owner was worried about was never the refusals — it was what the filter was
          hiding. Dropping onto backdraft showed {cameraCensus.offeredInputs} inputs and silently
          dropped {cameraCensus.refusedInputs}; and the <b>"show all"</b> button offered beside that
          sentence was <code>disabled</code>, so the count was the only thing you could ever learn.
        </p>
        <p>
          So the partition is now <b>by the compatibility predicate itself</b> — the question the
          user is actually asking. Compatible inputs are shown; everything else collapses behind
          <b>"{cameraCensus.refusedInputs} not compatible"</b>, expandable, each row still carrying
          its reason. In effect this <i>is</i> the owner's filter — carrying a video cable, the
          compatible inputs are the video-ish ones, so the default view is the same short list — but
          the omission is recoverable instead of terminal.
        </p>
        <p class="warn">
          ⚠ It also fixes a conflation the last round flagged in its own prose and then shipped
          anyway. <code>canConnect('cv', &lt;any video type&gt;)</code> is <code>true</code>, so
          "video ports" and "ports that can carry this patch" are <i>different sets</i> — and a
          DOMAIN filter gets that wrong in both directions. A compatibility partition cannot, because
          it is the predicate.
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

            rearOpen
          />
        </div>
        <div class="pair-cell">
          <p class="pair-cap">…and a port whose own <code>accepts</code> widens the rule</p>
          <DropPatchModal
            dropped={{ nodeId: 'com-1', def: defs.colourofmagic }}
            onto={{ nodeId: 'camera-1', def: defs.camera }}
            direction="downstream"

            rearOpen
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
        <p>
          <b>The finding from last round is now FIXED, not written down.</b> Each owner's guard used
          to name the others by hand — the dock read
          <code>fullViewNodeIds.length &gt; 0</code> and the canvas hard-coded the exact complement
          <code>=== 0</code>. Correct for two owners; silently wrong for three, because the new
          surface had to be added to <i>every</i> existing guard and <b>nothing fails loudly if you
          forget</b>. The symptom is two handlers on one keystroke and two flip states
          phase-diverging — a bug this codebase already had once (<code>7e21befe2</code>) and fixed
          by hand.
        </p>
        <p>
          Precedence now lives in one ordered list, <code>FLIP_KEY_CLAIMANTS</code>
          (<code>workflow-pins.ts</code>), and a surface <b>registers</b> its occupancy with
          <code>setFlipKeyOccupancy()</code>. Every guard asks only about itself —
          <code>flipKeyOwner() === 'canvas'</code> — so the two shipped guards in
          <code>Canvas.svelte</code> were rewritten to name nobody, and <b>adding this modal
          required no edit to either of them</b>. The unit test enumerates the whole power set of
          occupancy states and asserts exactly one claimant sees itself as the owner in each, over
          the claimant <i>list</i> rather than over the owners that happen to exist today.
        </p>
        <p class="warn">
          ⚠ <b>Still live, and NOT fixed here.</b> Four sequencer cards
          (<code>SequencerCard</code>, <code>PolyseqzCard</code>, <code>DrumseqzCard</code>,
          <code>CartesianCard</code>) handle Tab on their step buttons with
          <b>no <code>stopPropagation</code></b> — grep returns zero in all four files and in
          <code>NoteEntry.svelte</code>. A gate button is not a typing target, so
          <code>isTypingTarget</code> does not save it: the window flip handler fires on the same
          keystroke and <b>Tab advances the step AND flips the rack</b>. The resolver above does not
          help — this is not an arbitration bug, it is a propagation bug, and its fix belongs in
          those four cards with its own issue. Left alone deliberately rather than folded into a
          design PR.
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
        <h3>⚠ what is still NOT real — read this before poking at scene 0</h3>
        <p>
          The gesture works. It works <b>in this sandbox</b>, on a private canvas, against a local
          edge list. Everything below is a real gap, stated plainly because scene 0 invites you to
          expect otherwise.
        </p>
        <ul>
          <li>
            <b>It is not wired into the rack.</b> Deliberate — the scope on this PR is a working
            interaction to review, not a shipped feature. <code>Canvas.svelte</code>'s
            <code>handleNodeDragStop</code> is <b>untouched</b>. See the adoption note below for
            exactly what turning it on would take.
          </li>
          <li>
            <b>The cards are stand-ins.</b> <code>SandboxFace</code> draws port dots from the def;
            it is not <code>PatchPanel</code>. The DRAG, the GEOMETRY and the DEF are real; the
            pixels of the card are not, so this tells you nothing about how the gesture feels
            against a real faceplate at real size.
          </li>
          <li>
            <b>Undo is a local stack, not the Y.Doc UndoManager.</b> The SHAPE is right — one modal
            session is one entry — but adopting it means one
            <code>ydoc.transact(fn, LOCAL_ORIGIN)</code> around the committed set.
            <b>Redo is not implemented at all</b> (Shift-⌘Z does nothing).
          </li>
          <li>
            <b>Committing does not create a real patch.</b> An edge is pushed to the sandbox's own
            list and drawn. Nothing calls the graph mutators, no engine node is connected, and
            <b>overwrite of an already-occupied input is not modelled</b> — neither is the
            destructive-overwrite warning the shipped cascade shows.
          </li>
          <li>
            <b>No hover affordance during the drag.</b> The HUD tells you the numbers, but the
            candidate card does not highlight, and there is no drop shadow. That is the single
            biggest thing between this and something that feels finished.
          </li>
          <li>
            <b>Multi-select drags are ignored</b> (fall through as an ordinary move). "Which of
            these did you mean" has no answer, so no answer is invented.
          </li>
          <li>
            <b>Touch and pen are untested.</b> The threshold is centre-containment, which has no
            pointer dependence, but nothing was tried on a touch device.
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
            ⚠ <b>These scenes force the backpanel OPEN.</b> #1838 made it collapse by default
            behind the same counted disclosure the refusals use — the owner's call, and what the
            rack now shows. Every scene here passes <code>rearOpen</code> because showing the
            panel is the entire point of the page; nothing else does.
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

      <div class="callout" data-testid="adoption">
        <h3>what adopting it into the rack would take</h3>
        <p>
          The seam was kept narrow on purpose: the decision is a <b>pure function over rects</b>
          (<code>pickDropTarget</code>), so nothing about it is coupled to the sandbox. Adoption is
          a move, not a rewrite:
        </p>
        <ul>
          <li>
            <b>One call at the top of <code>handleNodeDragStop</code>.</b> Build the dragged rect
            from the payload's <code>n.position</code> plus <code>nodeFootprintPx(n.id)</code>
            (mirroring <code>recomputeLassoHits</code>), call <code>pickDropTarget</code> against
            <code>flowApi.getNodes()</code>. ⚠ Build a <b>Rect</b> — do not pass a node or an id.
            <code>getIntersectingNodes</code> resolves ids through <code>store.nodeLookup</code>,
            i.e. the <i>committed</i> position, while the lane hit-test three lines below reads the
            <i>payload</i> position, and both e2e drivers for that seam deliberately pass synthetic
            positions that differ from the store. Resolving by id would silently disagree with lane
            membership under exactly the tests that pin lane membership.
          </li>
          <li>
            <b>On a claim: rewrite <code>n.position</code> to the pre-drag value and let the rest of
            the handler run unchanged.</b> Not an early return — falling through means the
            membership pass, the <code>topNodeId</code> clear and the position write all compute
            from the original coordinates, so they reach exactly what they would have with no drag.
            That is the whole non-interference argument, and it needs no new branch in the
            membership block.
          </li>
          <li>
            <b>Pre-drag position needs capturing.</b> Canvas wires no
            <code>onnodedragstart</code> today; the sandbox uses one. Alternatively read it back
            from <code>patch.nodes[id].position</code> before the write — but ⚠ <b>not</b> for a
            lane member, whose position is derived from its order index rather than stored.
          </li>
          <li>
            <b>Commit through the graph mutators inside one
            <code>ydoc.transact(fn, LOCAL_ORIGIN)</code></b>, which gives the session-is-one-undo
            property for free from the existing UndoManager.
          </li>
          <li>
            <b>Tab needs nothing.</b> The modal already registers through
            <code>setFlipKeyOccupancy('drop-modal', …)</code> and the claimant list already names
            it, innermost. That work landed in this PR.
          </li>
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
