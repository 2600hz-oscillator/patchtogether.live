<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Push2Diagram from './Push2Diagram.svelte';
  import { pushLegendView } from '$lib/control/push2/push-legend-model';
  import type { LaunchpadLegendContext } from '$lib/control/launchpad/launchpad-control.svelte';
  import { PUSH_CC_SCENE_BASE, PUSH_CC_PERMANENT_BASE } from '$lib/control/push2/push2-map';
  import { AUDIO_ENTRY, AUDIO_RIGHT_BINDINGS } from '$lib/control/launchpad/launchpad-audio-map';
  type Mode = 'grid' | 'clip' | 'keys' | 'control' | 'audio' | 'lengthEdit' | 'arranger';
  let { initialMode = 'grid' }: { initialMode?: Mode } = $props();
  let mode = $state(untrack(() => initialMode));
  let shift = $state(false);
  let ready = $state(false);
  onMount(() => { ready = true; });
  const modes: { id: Mode; label: string }[] = [
    { id:'grid', label:'Grid' }, { id:'clip', label:'Clip' }, { id:'keys', label:'Keys / arp' },
    { id:'control', label:'Control' }, { id:'audio', label:'Audio' },
    { id:'lengthEdit', label:'Length' }, { id:'arranger', label:'Arranger' },
  ];
  let context = $derived<LaunchpadLegendContext>({ deployment:'single', bound:true, gridHeld:false, sceneScrollOffset:0,
    shift, view: mode === 'grid' || mode === 'clip' || mode === 'control' || mode === 'arranger' ? mode : mode === 'audio' ? 'control' : 'clip',
    mode: mode === 'audio' || mode === 'keys' || mode === 'lengthEdit' ? mode : 'session',
  });
  let legend = $derived(pushLegendView(context));
  const colors = ['#bc5265','#c4a34f','#8eaf58','#52b888','#51acb7','#608cc9','#996bc5','#ba689e'];
  let pads = $derived(Array.from({ length:64 }, (_, i) => {
    const x = i % 8, y = Math.floor(i / 8);
    const fill = mode === 'grid' ? (y === 7 ? colors[x]! : '#243044')
      : mode === 'audio' ? (x === 0 && y === 6 ? '#b695dc' : '#343042')
      : mode === 'clip' ? ((x + y * 2) % 7 === 0 ? '#e4e6eb' : '#273342')
      : mode === 'keys' ? (y === 0 || y === 7 ? '#595143' : (x + y * 3) % 12 === 0 ? '#ce9b48' : '#375444')
      : mode === 'lengthEdit' ? (y === 7 && x < 4 || y === 6 ? '#95a864' : '#202630')
      : mode === 'control' ? (y === 5 ? '#3f827e' : y === 3 ? '#795537' : y === 1 ? '#536eaa' : '#243044')
      : '#202630';
    return { x,y,fill };
  }));
</script>

<section id="pad-modes" class="pad-guide" data-testid="push2-pad-guide">
  <h2>Pad modes — a reference on the Push itself</h2>
  <p>Choose a mode below to inspect its button map. The labels come from the same routing model as the hardware LEGEND. Pad colors illustrate each page; the mode-specific instructions explain the gestures.</p>
  <div class="mode-buttons" role="group" aria-label="Push guide mode">
    {#each modes as item}<button disabled={!ready} aria-pressed={mode === item.id} onclick={() => mode = item.id}>{item.label}</button>{/each}
    <label><input type="checkbox" disabled={!ready} bind:checked={shift} /> Show SHIFT layer</label>
  </div>
  <Push2Diagram {pads} lowerLabels={legend.function.cells.map(c => c.label)} sceneLabels={legend.scene.cells.map(c => c.label)}
    encoderLabels={['—','CARD','E1','E2','E3','E4','E5','E6','E7','E8','Mst']} upperLabels={['L1','L2','L3','L4','L5','L6','L7','L8']}
    caption={`${legend.context}${shift ? ' + SHIFT' : ''}. Function buttons run left to right under the display; scene buttons run top to bottom beside the pads. Grid example is illustrative.`} />
  <div class="map-columns">
    <div><h3>Below display · left to right</h3><ol>{#each legend.function.cells as cell}<li><strong>{cell.label || 'Unassigned'}</strong> <code>CC {PUSH_CC_PERMANENT_BASE + cell.index}</code></li>{/each}</ol></div>
    <div><h3>Right column · top to bottom</h3><ol>{#each legend.scene.cells as cell}<li><strong>{cell.label || 'Unassigned'}</strong> <code>CC {PUSH_CC_SCENE_BASE + 7 - cell.index}</code></li>{/each}</ol></div>
  </div>
  {#if mode === 'grid'}
    <h3>Launch, inspect, copy and repeat</h3>
    <p>Columns are lanes; rows are slots. Tap to launch or stop the playing clip. <strong>Hold GRID + tap</strong> to inspect without changing playback: notes open CLIP, audio opens AUDIO. Double-tap also opens the clip, but the first tap is a launch gesture before its prior intent is restored.</p>
    <p>Hold SHIFT for the right-column tools shown above. COPY and PASTE stay armed when SHIFT is released; select their clip target afterward. For scene copy/paste, release SHIFT and use a scene button. Clipboard types must match. CLIP-DIV and LENGTH require SHIFT to remain held while targeting a clip. SCROLL UP/DOWN reaches later scene slots; swing buttons adjust the selected lane.</p>
    <p><strong>Scene repeats:</strong> hold GRID and the desired scene button together, then choose a pad in the orange count grid. Pads count 1–63 from the upper-left across rows; pad 64 means infinity. Release either held button to exit. See <a href="/docs/modules/clipplayer#scenes">scene behavior</a>.</p>
  {:else if mode === 'clip'}
    <h3>Write notes, with hit velocity</h3>
    <p>The pads show an eight-step, eight-pitch window. Tap a cell to add/remove a note; Push records your hit velocity when entering a note. Hold a note and tap farther along its row to extend it. Hold SHIFT and tap a note to open probability; a second quick tap opens PLAY EVERY. Its top row selects loops 1–8; 1 plays every loop.</p>
    <p>The right column contains DOUBLE, LENGTH, VEL HOLD, KEYS, pitch-window and step-window controls. Hold VEL HOLD while tapping notes to change velocity; SHIFT + that button toggles FOLLOW. D-Pad moves the pitch/step window; SHIFT uses eight-step/eight-row jumps. FOLLOW advances the step window with playback. Length, custom scales and pitch probability are explained in <a href="/docs/modules/clipplayer#notes">the note guide</a>; pitch probability and custom-scale editing stay on screen.</p>
    <p>For probability, choose its level from the grid. Clip and note settings have distinct colors. In the probability page, SHIFT + the top-right pad resets note-level overrides when editing a clip default. COPY and PASTE live in GRID, not the note editor.</p>
  {:else if mode === 'keys'}
    <h3>Play notes and record them</h3>
    <p>Enter KEYS from the CLIP right column. The middle six rows form a fourths keyboard; your strike velocity controls note velocity. The top row selects octave. The bottom row provides QUEUE-REC, OVERDUB, EXIT and arp controls. The right column chooses scale, with its bottom button toggling ARP. Hold SHIFT to see the arp settings in the map.</p>
    <p><strong>QUEUE-REC</strong> starts transport if needed and arms additive note capture. It punches in at the first played note while running or the next clip wrap. It does not erase untouched steps when OVERDUB is off. Turn OVERDUB from on to off during capture to finish at the next wrap; EXIT stops capture immediately before leaving KEYS. Arming is blocked during arrangement recording/playback.</p>
    <p>Arp offers range, direction, timing, swing and latch. Its generated notes are not written by QUEUE-REC; use <a href="/docs/modules/clipplayer#audio">audio capture</a> to save that sound. The underlying clip continues playing while KEYS supplies live notes.</p>
  {:else if mode === 'control'}
    <h3>Performance controls</h3>
    <p>Top grid row: tempo − / RESET / tempo + / STOP-ALL. Second row: arranger REC and SES/ARR playback toggle; AUDIO is column {AUDIO_ENTRY.x + 1}. The MONO, MUTE and RATE rows have one pad per lane. The right column stops individual lanes.</p>
    <p><strong>AUTO arm:</strong> hold the permanent-row SHIFT and press the lane 1–7 function button. Lane 8 uses the pad directly below SHIFT. That arm belongs to <a href="/docs/modules/clipplayer#automation">the playing note clip’s automation</a>; it is not AUDIO or arranger REC.</p>
  {:else if mode === 'audio'}
    <h3 id="audio">Record and replay audio</h3>
    <p>Enter <strong>CONTROL → AUDIO</strong>: column {AUDIO_ENTRY.x + 1}, row {8 - AUDIO_ENTRY.y} from the top. Tap the target slot without launching it. BANK UP/DOWN moves through eight-slot banks, reaching all 64 slots. The display reports the inspected lane/slot and frozen record target.</p>
    <ol>
      <li>Choose an empty target. Press <strong>{AUDIO_RIGHT_BINDINGS[1].legend}</strong> to select one loop or endless recording.</li>
      <li>Press the top-right <strong>{AUDIO_RIGHT_BINDINGS[0].legend}</strong>, then physical Play if transport is stopped. Arming alone does not start it.</li>
      <li>One loop finishes automatically. For endless recording, press ARM / FINISH again; saving waits for the current loop end. During a single-loop take, the same press cancels.</li>
      <li>The take launches after saving. PLAY TAKE queues it again; REC / LIVE bypasses or enables it. Return to GRID and launch the original note slot to hear notes again.</li>
    </ol>
    <p><strong>REPLACE TAKE</strong> requires two consecutive presses; another action cancels confirmation. The old take remains until the new take saves. EXIT AUDIO does not cancel recording. Notes and recorded automation are protected.</p>
    <p>Amber pulses while armed, red means recording, alternating red/amber means finishing, and purple marks stopped audio. While Electra mode is on it retains display priority; LEGEND overrides both. Encoders keep their normal parameter assignments. The physical Record button is unbound; it does not arm audio.</p>
    <p>See <a href="/docs/modules/clipplayer#audio">audio behavior</a>, <a href="/docs/modules/clipplayer#routing">mixer routing</a> and <a href="/docs/modules/clipplayer#recovery">media and recovery</a>.</p>
  {:else if mode === 'lengthEdit'}
    <h3>Exact note-clip length</h3>
    <p>Enter LENGTH from the CLIP right column or the SHIFT GRID tools. Top row selects the ending 16-step block; the next two rows select its exact step 1–16. The top right-column button exits. Notes beyond a shortened end remain stored. A clip can contain up to 128 steps.</p>
  {:else}
    <h3>Arranger view is reserved</h3>
    <p>The ARRANGER view button currently selects a blank reserved pad page. To record clip launches, use CONTROL’s REC and SES/ARR controls. To edit or overdub that launch log, use Clip Player’s on-screen ARR controls. Printed SONG is a separate note-recording workflow on screen. See <a href="/docs/modules/clipplayer#song">Song versus arrangement</a>.</p>
  {/if}
  <p class="scope">LEGEND documents the two button rows, including their SHIFT layers. It does not label the pad matrix, encoder assignments, probability pages, copy/paste targets or GRID-held repeat selector; those gestures are documented above.</p>
</section>

<style>
  .mode-buttons { display:flex; flex-wrap:wrap; align-items:center; gap:7px; margin:1rem 0; }
  button { border:1px solid #566174; background:#202735; color:#dfe7ef; border-radius:5px; padding:7px 11px; font:inherit; cursor:pointer; }
  button[aria-pressed='true'] { border-color:#ad91d6; background:#46345c; }
  label { display:flex; align-items:center; gap:5px; margin-left:10px; }
  .map-columns { display:grid; grid-template-columns:1fr 1fr; gap:1.5rem; }
  .map-columns h3 { font-size:1em; }.map-columns li { margin-bottom:.25rem; }code { color:#acb8c9; font-size:.85em; }
  .scope { color:#aab7c7; font-size:.9em; border-top:1px solid #394251; padding-top:1rem; }
  @media(max-width:600px) { .map-columns { grid-template-columns:1fr; gap:0; } }
</style>
