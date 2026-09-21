<script lang="ts">
  import { CLIP_LANES, SCENE_STRIDE, MAX_CLIP_STEPS, MAX_AUTOMATION_TRACKS } from '$lib/audio/modules/clip-types';
  import ClipplayerGuideDiagram from './ClipplayerGuideDiagram.svelte';
  import ClipplayerMonomeDocs from './ClipplayerMonomeDocs.svelte';
  const sections = [
    ['overview', 'How it works'], ['quick-start', 'First notes'], ['session', 'Session & channels'],
    ['notes', 'Note editor'], ['audio', 'Record & play audio'], ['automation', 'Automation'],
    ['scenes', 'Scenes & repeats'], ['song', 'Song & arrangement'], ['routing', 'Routing & clock'],
    ['controllers', 'Hardware'], ['recovery', 'Recovery & troubleshooting'], ['reference', 'Full reference'],
  ];
</script>

<article class="clip-guide" data-testid="clipplayer-guide">
  <p class="intro">Build note patterns, record audio takes, and loop control movements in one clip grid. This guide explains Clip Player itself. The <a href="/docs/modules/push2Control">Push 2</a> and <a href="/docs/modules/launchpadControlLeft">Launchpad</a> guides show the physical controls for the same workflows.</p>
  <nav class="contents" aria-label="Clip Player guide contents">
    {#each sections as [id, label]}<a href={`#${id}`}>{label}</a>{/each}
  </nav>

  <section aria-labelledby="overview">
    <h2 id="overview">How the pieces fit</h2>
    <p>A <strong>lane</strong> is one instrument or audio channel. Clip Player has {CLIP_LANES} lanes, with {SCENE_STRIDE} stored slots per lane. Only one clip plays in a lane at a time. Each clip keeps its <strong>notes, automation and optional recorded-audio layer together in the same slot</strong>.</p>
    <div class="concepts">
      <div><strong>NOTES source</strong><span>The clip’s notes become pitch, gate and velocity. Patch these to a voice to hear them.</span></div>
      <div><strong>RECORDED source</strong><span>The same clip plays its saved stereo take instead of generating notes. Its notes remain editable.</span></div>
      <div><strong>Automation · teal dot</strong><span>Control movements belong to the clip and continue with either playback source.</span></div>
    </div>
    <p><strong>Inspecting, launching and choosing a record target are separate actions.</strong> The editor can show a stopped clip while a different slot plays. Once audio is armed, its destination stays fixed even if you inspect something else.</p>
    <p>TIMELORDE supplies the shared clock. With QNT on, queued launches wait for the next boundary of the <strong>longest currently playing clip</strong>. NOW bypasses that wait. If nothing is playing yet, the first launch starts immediately.</p>
  </section>

  <section aria-labelledby="quick-start">
    <h2 id="quick-start">Your first note clip</h2>
    <ol>
      <li>Add Clip Player and enable audio. Use the rack’s TIMELORDE for tempo and transport.</li>
      <li>Open Clip Player’s full view. In <strong>SESSION</strong>, double-click an empty pad in lane 1 to open <strong>EDITOR</strong>.</li>
      <li>Click piano-roll cells to add notes. Time runs left to right; higher pitches are higher on the screen.</li>
      <li>Patch <code>pitch1</code> to a voice’s pitch input, <code>gate1</code> to its envelope or gate input, and the voice’s audio to your mixer/output. Add <code>vel1</code> where your voice accepts velocity.</li>
      <li>Start transport and press <strong>NOW</strong> in the editor. Return to SESSION to launch other clips.</li>
    </ol>
    <p class="callout">No controller is required. Drawing notes alone does not make sound: the NOTES source needs a connected voice. Record that voice to attach its sound to the same clip, then choose RECORDED to play the saved take.</p>
  </section>

  <section aria-labelledby="session">
    <h2 id="session">Session, channels and playback</h2>
    <ClipplayerGuideDiagram view="session" />
    <table>
      <thead><tr><th>Where</th><th>What you do there</th></tr></thead>
      <tbody>
        <tr><td><strong>SESSION</strong></td><td>Launch grid, per-lane MUTE / STOP / AUDIO / AUTO, scene launch and repeat controls, selected-clip inspector.</td></tr>
        <tr><td><strong>CHANNELS</strong></td><td>Set each lane to mono or poly, choose its RATE, and toggle the same AUTO arm found in Session.</td></tr>
        <tr><td><strong>EDITOR</strong></td><td>Edit the selected clip’s notes, inspect its recorded waveform and choose NOTES / RECORDED. NOW / QUEUE launch that selected clip.</td></tr>
        <tr><td><strong>PLAYBACK</strong></td><td>Global STEP, QNT, S&amp;H, OCT and GATE settings. These are shared across lanes.</td></tr>
        <tr><td><strong>Above the tabs’ content</strong></td><td>Transport and tempo nudges, stop-all/reset, undo/redo, hardware binding, arrangement/song controls and automation status remain available across views.</td></tr>
      </tbody>
    </table>
    <p>On screen, <strong>columns are lanes and rows are slots</strong>. Click a loaded pad to launch or queue it; click the currently playing pad to stop its lane. Double-click opens its note editor, with audio controls alongside when it has a take. Shift-click launches immediately. An empty pad can become a note placeholder, but opening an empty editor alone writes no notes.</p>
    <p><strong>MUTE</strong> silences a lane while retaining its running clip. <strong>STOP</strong> stops that lane. Stop-all is the immediate panic action. <strong>RST</strong> re-aligns active clips to their first step; it does not rewind the arrangement or launch stopped lanes.</p>
    <p>The screen grid shows the first eight slots. The selected-clip LANE / SLOT selectors reach all {SCENE_STRIDE} slots without launching. Hardware banking reaches the extended slot range. Scene repeats for the first eight scenes sit beside the screen grid.</p>
    <p>Right-click a pad for COPY, PASTE and CLEAR, plus note-specific probability controls. The screen, Push and Launchpad share a local clipboard. A whole-clip copy carries its notes, automation and attached audio; the audio keeps its media reference. A scene buffer pastes into a scene, and a clip buffer into a clip. A paste replaces the destination’s contents as one undoable edit. Menu CLEAR deletes all of that clip’s layers.</p>
  </section>

  <section aria-labelledby="notes">
    <h2 id="notes">Write and shape note clips</h2>
    <ClipplayerGuideDiagram view="notes" />
    <p>The piano roll shows the selected clip’s editable pitch range and full length, up to {MAX_CLIP_STEPS} steps. Click an empty cell to add and select a note. Click an existing note to select it; click that selected note again to erase it. <strong>Shift-click a later cell on the same pitch row</strong> to hold the selected note through that step. The tied span appears as one solid bar. <strong>Alt-click</strong>, or turn on <strong>VEL</strong> and click, to cycle velocity. Right-click an existing note to open its menu.</p>
    <p>Ordinary step notes use the global GATE setting; tied notes sustain across their span. Notes recorded from hardware KEYS can carry their own held duration, including a fraction of a step, so changing GATE does not shorten those captured gates. A recorded note ends no later than the clip’s end. Tying it in the editor replaces that captured duration with the span you choose.</p>
    <table>
      <thead><tr><th>Control</th><th>Behavior</th></tr></thead>
      <tbody>
        <tr><td>Scale / length</td><td>Cycle the clip’s scale and step count. Length changes retain notes outside the current end; extending the clip brings them back.</td></tr>
        <tr><td>×2</td><td>Double the clip’s duration and copy its notes into the new half, up to the maximum length.</td></tr>
        <tr><td>DIV</td><td>A clip-specific clock division overrides the lane RATE. The playback change is latched at a loop boundary.</td></tr>
        <tr><td>SW − / +</td><td>Adjust the lane’s swing; delayed odd steps give the pattern its groove.</td></tr>
        <tr><td>Mono / poly in CHANNELS</td><td>Mono replaces an existing pitch when you add another at that step. Poly keeps the chord; use a poly-capable voice to hear every pitch.</td></tr>
        <tr><td>SCALE… / APPLY SCALE</td><td>Check pitch rows to define this lane’s custom note set, then apply it. REMOVE SCALE reveals the other rows again. Hidden notes remain stored and keep playing.</td></tr>
        <tr><td>RESTRICT RANGE / FLOOR</td><td>Show a compact three-octave window instead of the full pitch range. These are view controls; they do not transpose or filter playback.</td></tr>
        <tr><td>⌫ / CLEAR / CLR AUTO</td><td>⌫ empties notes and automation while keeping the clip and its audio. Menu CLEAR deletes the whole clip, including attached audio. CLR AUTO removes only that clip’s recorded control movements.</td></tr>
      </tbody>
    </table>
    <h3>Probability, pitch variation and loop skips</h3>
    <p><strong>NOTE PROBABILITY</strong> controls whether a note fires. <strong>SKIP EVERY</strong> plays it only on every Nth loop, from 1 to 8. Both conditions must pass. <strong>PITCH PROBABILITY</strong> varies the played pitch around the written note using the clip’s scale; it is set from the screen menu.</p>
    <div class="legend" aria-label="Note variation legend"><span><i class="always"></i>Always</span><span><i class="chance"></i>Probability</span><span><i class="skip"></i>Every Nth loop</span><span><i class="pitch"></i>Pitch can vary</span></div>
    <p>Probability dims the note toward purple/orange; loop skips tint it red; combined settings blend those colors. Pitch variation adds a dashed border. The tooltip and menu show exact values. On a pad’s clip menu, probability becomes the clip default while skip and pitch variation apply to its notes. On a note cell, the change affects that note.</p>
    <p>Loop skips and pitch variation follow shared deterministic timing. Firing-probability rolls are currently local to each peer, so collaborators can hear different dropouts.</p>
    <h3 id="audition">Hear the clip you are editing</h3>
    <p><strong>NOW</strong> switches its lane to this clip immediately. <strong>QUEUE</strong> follows QNT and the shared reference boundary. Neither requires leaving the editor. If the clip has a take, choose <strong>NOTES</strong> to hear your note edits; editing notes does not rewrite saved audio. Live hardware KEYS and arpeggiator entry are described in the controller guides; recording those notes is additive and separate from audio capture.</p>
  </section>

  <section aria-labelledby="audio">
    <h2 id="audio">Record audio, then choose what you hear</h2>
    <ClipplayerGuideDiagram view="audio" />
    <div class="flow" aria-label="Audio recording workflow">
      <div><b>1 · Select</b><span>Your existing clip<br/>LANE / SLOT</span></div><div><b>2 · Arm</b><span>Choose 1 or ∞<br/>RECORD AUDIO</span></div><div><b>3 · Capture</b><span>Play that clip<br/>Its own loop boundary</span></div><div><b>4 · Listen</b><span>Take attached here<br/>NOTES / RECORDED</span></div>
    </div>
    <ol>
      <li>Route the sound to the matching <strong>MIXMSTRS channel input</strong>. Lane 1 captures channel 1, and so on. Add MIXMSTRS if the rack does not have it.</li>
      <li>Select the existing clip whose sound you want to record using the <strong>LANE / SLOT</strong> selectors below the Session grid. This does not launch it. Recording temporarily uses <strong>NOTES</strong> so the clip drives its patched voice, even when replacing an existing take.</li>
      <li>Choose <strong>1 · ONE LOOP</strong> or <strong>∞ · UNTIL FINISH</strong> using that lane’s AUDIO row. Press the red AUDIO arm or <strong>RECORD AUDIO</strong>. If the clip already has a take, use <strong>REPLACE TAKE… → REPLACE AND ARM</strong>. The take stays attached to this same lane and slot.</li>
      <li>Launch that clip and start transport when ready. Arming alone does neither: it can wait while transport is stopped or a different clip is playing. Capture starts on the target clip’s loop boundary and measures that clip’s own loop, even when another lane has a longer clip. The visible status identifies the target and phase.</li>
      <li>A one-loop take finishes automatically. For endless recording, press the arm again to finish at the end of the current loop. During a one-loop take, pressing it again cancels the unfinished take. The clip keeps rendering its notes through the stopping phase; wait for the take to finish saving.</li>
    </ol>
    <p>Saving attaches the stereo take to the same clip and selects <strong>RECORDED</strong>. It keeps that clip’s lane and slot, preserves notes and automation, and does not queue an extra launch. <strong>NOTES</strong> plays its note sequence through the voice; <strong>RECORDED</strong> plays its saved audio instead of generating those notes. Switch between them on this clip. Automation continues in either source.</p>
    <p>Double-click the clip to keep editing its notes, with waveform and source controls alongside. A purple audio indicator means the clip has a saved take. Note edits do not alter that take; choose NOTES to hear them and record again when you want an updated audio layer.</p>
    <p>Stopping transport during an endless take keeps completed whole loops; an incomplete single-loop take is discarded. Audio plays at its recorded duration: it is not time-stretched when you change tempo, STEP or RATE. Keep the capture tempo when you need the take to stay aligned with note loops.</p>
    <p><strong>A long take does not lengthen the note clip.</strong> Record four passes of a 16-step clip and its notes and automation still loop every 16 steps; launches and stops still use that original clip length. The attached audio repeats its full four-pass captured duration.</p>
    <p><strong>REPLACE TAKE…</strong> asks for confirmation before replacing the clip’s audio layer. The original take stays until the new take commits; its notes and automation are preserved. Copy the whole clip to another slot first if you want to keep a version with the old take. An armed target cannot move; cancel the arm before choosing a different clip.</p>
    <p>Leaving the editor, closing the full view or disconnecting a controller does not end a take. Recording belongs to the module. A collaborator’s armed lane cannot be taken over from your controls. Interrupted or refused takes report a reason rather than silently recording somewhere else.</p>
    <p>Older racks can contain standalone audio clips. These remain readable and playable; their editor shows the saved waveform. New recording adds an audio layer to your existing clip.</p>
  </section>

  <section aria-labelledby="automation">
    <h2 id="automation">Record control movements with AUTO</h2>
    <div class="flow automation-flow" aria-label="Automation ownership and recording workflow">
      <div><b>Assign a module</b><span>Module menu →<br/>Assign to automation lane</span></div><div><b>Launch a note clip</b><span>The playing clip<br/>owns the envelope</span></div><div><b>Arm that lane’s AUTO</b><span>Punch in at that<br/>clip’s next loop start</span></div><div><b>Move controls</b><span>Continuous overdub<br/>until AUTO is disarmed</span></div>
    </div>
    <p>The <strong>teal AUTO button above each Session lane</strong> is the per-lane automation-record arm. CHANNELS exposes the same arm next to RATE. It is independent of the red AUDIO arm and of arrangement recording.</p>
    <ol>
      <li>Open the menu of a module you want to automate and choose <strong>Assign to automation lane</strong>. Assign the whole module to one lane; its border shows that lane’s color.</li>
      <li>Launch a note clip in that lane, then arm AUTO. The recorder waits for that playing clip’s own loop start, even when another lane has a different length.</li>
      <li>Move the assigned module’s controls. Screen, MIDI and Electra gestures record. Supported CV bridge targets can also record effective values; a human touch takes precedence. Unassigned modules do not record into that lane.</li>
      <li>Continue across loops to overdub. Only controls you are moving are rewritten; the other recorded tracks keep playing. Disarm AUTO to finish. Stopping mid-loop preserves the untouched tail.</li>
    </ol>
    <p>A teal dot marks clips with automation. Copying the clip carries its automation; reverse paste reverses its notes and envelopes. Each clip holds up to {MAX_AUTOMATION_TRACKS} recorded controls. The MAX indicator reports the limit; ASSIGNED and REC report assignment and recording state, with details in their tooltips. Automation continues when the clip switches between NOTES and RECORDED, including mixer control movements.</p>
    <p>Live control gestures temporarily override playback. Release the control to return to automation; the override indicator can re-enable all controls. At a lane stop or switch, controls hold their last automated value instead of resetting. Multiple lanes can record at once, with one recording client per lane.</p>
    <p><strong>CLR AUTO</strong> in the editor clears that clip’s envelopes while keeping its notes and audio. A control’s menu can clear its recorded automation. <strong>Remove automation assignment</strong> only stops future recording for that module; existing envelopes still play. These are deliberately different operations.</p>
  </section>

  <section aria-labelledby="scenes">
    <h2 id="scenes">Scenes, repeats and longer sets</h2>
    <p>A <strong>scene</strong> launches the same slot across all lanes; empty members stop their lanes. On the screen and a single controller, that is a row. The paired Launchpad’s left matrix and monome rotate the view: lanes are rows and slots are columns.</p>
    <p>Scene repeat defaults to <strong>∞</strong>. Click its on-screen repeat control to cycle ∞ → 2 → 3 → 4 → 8 → ∞. Hardware offers counts 1–63. After that many passes of the scene’s longest clip, playback advances to the next scene with content, skipping empty scenes. At the last populated scene, it keeps looping.</p>
    <p>The duration is captured when the scene launches, so edits do not move an active countdown’s boundaries. Launching a scene resets its count; launching an individual clip outside it or stopping all scene lanes cancels the countdown. Muting does not. A whole-scene copy includes its repeat count.</p>
    <p>Slots 9–{SCENE_STRIDE} can play in Session and are reachable from the inspector and controller banks. The screen matrix itself does not scroll. The experimental arrangement recorder currently captures only slots 1–8.</p>
  </section>

  <section aria-labelledby="song">
    <h2 id="song">Capture a performance: SONG or ARR</h2>
    <span id="song-mode"></span>
    <ClipplayerGuideDiagram view="song" />
    <table>
      <thead><tr><th>Recording</th><th>What is saved</th><th>How to use it</th></tr></thead>
      <tbody>
        <tr><td><strong>AUDIO</strong></td><td>A stereo take attached to the existing clip, alongside its notes and automation.</td><td>Lane AUDIO arm; described above.</td></tr>
        <tr><td><strong>AUTO</strong></td><td>Control movements attached to a playing note clip.</td><td>Lane AUTO arm; described above.</td></tr>
        <tr><td><strong>ARR</strong> · experimental</td><td>The applied clip-launch and stop events, with their performance timing.</td><td>Use the SES / ARR row and its record toggle. RPL starts fresh; OVR layers launches onto the existing arrangement. ARR ⤢ opens the launch-log editor.</td></tr>
        <tr><td><strong>SONG</strong></td><td>The notes actually emitted while you perform, including their timing, duration and velocity.</td><td>Use ● SONG while performing in Session. RPL starts a fresh print; OVR adds to it. Switch SES to SONG to hear the printed performance.</td></tr>
      </tbody>
    </table>
    <p>Printed SONG captures the notes that survived probability and loop skips, with pitch variation, rate, division and swing already applied. It plays those events directly instead of re-running the original clip decisions. OCT remains a live output transpose. SONG is a note performance, <strong>not an audio mixdown</strong>, and currently does not print automation or recorded audio. A clip using RECORDED does not generate notes to print.</p>
    <p>ARR follows the clip-launch log, so its clips still supply their contents. Its editor lets you select a block, drag it horizontally with BAR / BEAT snapping, cycle its slot, delete it, or adjust the arrangement loop length by bars. The expanded ARR editor is the same launch-log view. There is no printed-song piano-roll editor.</p>
    <p>Use Session for hands-on launches. Song playback takes over the lanes; changing the playback mode is separate from arming a recorder. Neither SONG nor ARR replaces the lane’s AUDIO or AUTO workflow.</p>
  </section>

  <section aria-labelledby="routing">
    <h2 id="routing">Routing and timing reference</h2>
    <div class="routing-map" role="img" aria-label="One clip has notes and recorded audio. Notes drive a voice patched into MIXMSTRS. Capture attaches that input's audio to the same clip. Recorded playback replaces live monitoring in the same mixer channel without moving cables. Automation continues in either source.">
      <div><b>NOTES</b><span>This clip’s pitchN / gateN / velN → voice → MIXMSTRS channel N</span></div>
      <div><b>AUDIO capture</b><span>MIXMSTRS channel N input → audio layer of this same clip</span></div>
      <div><b>RECORDED</b><span>This clip’s saved take → same mixer channel; replaces live monitoring</span></div>
      <div><b>AUTO</b><span>This clip’s control movements → assigned modules, with either source</span></div>
    </div>
    <p>Capture uses the corresponding pre-fader input of the first available MIXMSTRS. <strong>Leave the instrument cables connected.</strong> With RECORDED selected, the attached take replaces the channel’s live input monitoring; with NOTES selected, the note sequence drives the voice again. No cable moves are needed. The lane’s <code>audioN L/R</code> outputs also expose recorded playback for custom routing. Mixer automation still applies because the take is captured before those mixer controls.</p>
    <p>If you explicitly patch this Clip Player’s <code>audioN L/R</code> into its matching MIXMSTRS channel, that cable route replaces the internal stereo return so the take is not doubled. Connecting either leg disables that internal pair; connect both legs for stereo. Ordinary instrument-input cables do not disable the return.</p>
    <table>
      <thead><tr><th>Control / input</th><th>Effect</th></tr></thead>
      <tbody>
        <tr><td>STEP</td><td>Global musical step resolution from TIMELORDE: 1/4, 1/8, 1/16 or 1/32.</td></tr>
        <tr><td>Lane RATE / clip DIV</td><td>1/8, 1/4, 1/2, 1, 2× or 4×. A clip DIV overrides its lane’s rate.</td></tr>
        <tr><td>QNT</td><td>Queue a launch to the longest playing clip’s boundary. NOW and Shift-click override it.</td></tr>
        <tr><td>OCT / GATE</td><td>Global octave transpose and ordinary step-note gate duty. Tied spans and explicit recorded-note durations keep their own lengths.</td></tr>
        <tr><td>S&amp;H</td><td>On: pitch holds through rests while gate closes. Off: resting pitch returns to zero.</td></tr>
        <tr><td>reset</td><td>A rising edge re-aligns active clip steps. Queued launches remain queued.</td></tr>
        <tr><td>stop_all</td><td>A rising edge stops all lanes immediately.</td></tr>
      </tbody>
    </table>
    <p>The transport controls operate TIMELORDE; local Play / Stop hide when it follows an upstream external clock. Detailed port types and parameter ranges are in the <a href="#reference">generated reference below</a>.</p>
  </section>

  <section aria-labelledby="controllers">
    <h2 id="controllers">Choose your control surface</h2>
    <div class="concepts controller-links">
      <a href="/docs/modules/push2Control"><strong>Push 2 →</strong><span>Physical button map, display / LEGEND, encoders, all pad modes and AUDIO.</span></a>
      <a href="/docs/modules/launchpadControlLeft"><strong>Launchpad →</strong><span>One-device views, paired matrix/deck, modifiers, keys, recording and LED meanings.</span></a>
      <a href="#monome"><strong>monome grid 128 ↓</strong><span>Serial setup, monochrome Session map, note editor and length pages.</span></a>
    </div>
    <p>Push 2 and Launchpad expose audio recording at <strong>CONTROL → AUDIO</strong>. The hardware guides explain how to pick a clip, arm, finish, switch NOTES / RECORDED, and confirm replacement without disturbing their permanent controls. They use the same clip layers and routing as the screen. The shared Push/Launchpad layer has one active controller surface at a time; a Launchpad pair is one surface.</p>
    <ClipplayerMonomeDocs />
  </section>

  <section aria-labelledby="recovery">
    <h2 id="recovery">Recovery, saving and troubleshooting</h2>
    <table>
      <thead><tr><th>What you see</th><th>What to check</th></tr></thead>
      <tbody>
        <tr><td>Notes are visible but silent</td><td>Choose NOTES, enable audio, run TIMELORDE, launch the clip, unmute the lane, and connect pitch/gate to a sounding voice.</td></tr>
        <tr><td>A saved take is silent</td><td>Choose RECORDED on that same clip, launch it, and check mute, media availability and the mixer’s output path. Keep its instrument-input cables connected. For custom routing, check audioN L/R.</td></tr>
        <tr><td>AUDIO is armed but waiting</td><td>Start transport and launch the target clip. Capture waits for that clip’s own loop boundary. Read the selected-clip status for the frozen target and any refusal.</td></tr>
        <tr><td>A target refuses recording</td><td>Select an existing clip, confirm replacement if it already has audio, wait for a finishing take, or let the collaborator who armed it finish. Existing notes and automation remain intact.</td></tr>
        <tr><td>AUTO records nothing</td><td>Assign the module, launch a note clip in that lane, arm AUTO and wait for its loop start. Check MAX if the clip already has {MAX_AUTOMATION_TRACKS} tracks.</td></tr>
        <tr><td>Audio unavailable on this device</td><td>The clip exists but its media could not load locally. Check the device/browser that recorded or imported the take; the waveform panel reports availability explicitly.</td></tr>
        <tr><td>An interrupted take is offered</td><td>Opening the full view scans recoverable local takes with at least one complete loop. RECOVER can attach audio to the original note clip while preserving its notes and automation. Its audio layer must be vacant; recovery refuses to overwrite an existing take without explicit replacement. DISCARD removes the unfinished take. Read the destination and take details before choosing.</td></tr>
      </tbody>
    </table>
    <p>Clip metadata and playback state are shared, but recorded audio bytes live in the browser’s local media storage; they are not streamed automatically to collaborators. A <strong>performance ZIP (.ptperf.zip)</strong> includes available referenced takes and restores them into the receiving browser. A plain <strong>.imp.json</strong> does not carry audio. Export reports missing media; keep the recording browser’s data until you have a complete media-bearing backup.</p>
    <p>Editor selection and hardware connection are personal. Saving or duplicating content does not preserve an active record arm. A duplicate starts stopped, disarmed and without claiming the original’s automation assignments. Undo/redo applies to content edits, not every transport action.</p>
    <p>For exact physical gestures and connection troubleshooting, use the linked hardware guides. The reference below is generated from the current module definition; this illustrated guide describes the workflow around those controls.</p>
  </section>
</article>

<style>
  .clip-guide { line-height:1.65; }
  .intro { font-size:1.12em; }
  .contents { display:flex; flex-wrap:wrap; gap:.45rem .7rem; padding:1rem; border:1px solid var(--doc-border-dim,#29434a); border-radius:8px; }
  .contents a { padding:.2rem .5rem; font-size:.9em; }
  section { margin-top:2.8rem; }
  h2,h3,[id] { scroll-margin-top:85px; }
  .concepts { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
  .concepts>div,.concepts>a { display:flex; flex-direction:column; gap:.4rem; border:1px solid var(--doc-border-dim,#29434a); padding:1rem; border-radius:8px; }
  .concepts span { font-size:.93em; }
  .callout { border-left:3px solid var(--doc-accent,#5ed5dd); padding:.5rem 1rem; background:rgb(100 180 200 / .06); }
  .flow { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin:1.5rem 0; }
  .flow>div { border:1px solid #9367b5; border-top:3px solid #b58bd9; padding:14px 12px; border-radius:5px; }
  .flow b,.flow span { display:block; }
  .flow span { margin-top:.6rem; font-size:.9em; }
  .automation-flow>div { border-color:#388f83; border-top-color:#6bd5be; }
  .legend { display:flex; flex-wrap:wrap; gap:1rem; }
  .legend span { display:flex; align-items:center; gap:.5rem; }
  .legend i { width:22px; height:17px; display:inline-block; border-radius:2px; }
  .always { background:#eee; }.chance { background:#9774b3; }.skip { background:#cf5968; }.pitch { background:#466d5b; border:2px dashed #d9e8de; }
  .routing-map { display:grid; gap:9px; padding:1rem; background:#17242b; border:1px solid #355760; border-radius:8px; color:#e0e9ed; }
  .routing-map>div { display:grid; grid-template-columns:145px 1fr; gap:12px; }
  td:first-child { min-width:120px; }
  @media(max-width:760px) { .concepts,.flow { grid-template-columns:1fr 1fr; } }
  @media(max-width:500px) { .concepts,.flow { grid-template-columns:1fr; } .routing-map>div { grid-template-columns:1fr; gap:0; } }
</style>
