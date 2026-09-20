<script lang="ts">
  import { CLIP_LANES } from '$lib/audio/modules/clip-types';
  let { view = 'session' }: { view?: 'session' | 'notes' | 'audio' | 'song' } = $props();
  const colors = ['#ef6574', '#e1b34e', '#a3ce61', '#63ce94', '#55ced1', '#7694ed', '#ba86ed', '#db7cc0'];
  const lanes = Array.from({ length: CLIP_LANES }, (_, i) => i);
  const titles = {
    session: 'Session: lane controls above the launch grid; selected clip below',
    notes: 'Note editor: clip tools above the piano roll; audition below',
    audio: 'Audio editor: recorded/live source, waveform, launch and record status',
    song: 'Arrangement and printed song are different recordings',
  };
</script>

<figure class="guide-figure" data-testid={`clip-guide-${view}`}>
  <svg viewBox="0 0 760 360" role="img" aria-label={titles[view]}>
    <title>{titles[view]}</title>
    <rect width="760" height="360" rx="10" fill="#171d25" />
    {#if view === 'session'}
      <text x="28" y="29" class="heading">SESSION</text>
      <text x="520" y="29" class="muted">SCREEN LAYOUT · annotated guide</text>
      {#each lanes as lane}
        <rect x={74 + lane * 42} y="46" width="36" height="6" rx="2" fill={colors[lane]} />
        <text x={92 + lane * 42} y="69" text-anchor="middle">{lane + 1}</text>
        {#each ['M', '■', '●  1', '◉'] as label, row}
          <rect x={74 + lane * 42} y={78 + row * 23} width="36" height="20" rx="3" fill={row === 3 ? '#193c39' : '#292f38'} stroke={row === 3 ? '#52b9ab' : '#49515c'} />
          <text x={92 + lane * 42} y={92 + row * 23} text-anchor="middle">{label}</text>
        {/each}
        {#each Array(4) as _, slot}
          <rect x={74 + lane * 42} y={181 + slot * 28} width="36" height="24" rx="3" fill={slot === 0 ? colors[lane] : '#242b34'} fill-opacity={slot === 0 ? '.38' : '1'} stroke={lane === 0 && slot === 1 ? '#bf93ef' : '#454c56'} stroke-width={lane === 0 && slot === 1 ? 2 : 1} />
          {#if slot === 0 || lane === 0 && slot === 1}<text x={92 + lane * 42} y={197 + slot * 28} text-anchor="middle">{slot === 0 ? 'N' : 'A'}</text>{/if}
        {/each}
      {/each}
      {#each Array(4) as _, slot}
        <text x="46" y={197 + slot * 28}>▷</text>
      {/each}
      <text x="16" y="91" class="tiny">MUTE</text><text x="16" y="115" class="tiny">STOP</text>
      <text x="16" y="138" class="tiny">AUDIO</text><text x="16" y="161" class="tiny teal">AUTO</text>
      <path d="M420 98 H452 M420 148 H468 M420 226 H450 M420 318 H460" class="leader" />
      <text x="480" y="82" class="number">1</text><text x="501" y="82">One control column per lane</text>
      <text x="480" y="103" class="muted">Mute and stop are separate actions.</text>
      <text x="480" y="138" class="number">2</text><text x="501" y="138">Two independent arms</text>
      <text x="480" y="159" class="muted">AUDIO captures sound. AUTO captures moves.</text>
      <text x="480" y="213" class="number">3</text><text x="501" y="213">Each row is a scene</text>
      <text x="480" y="234" class="muted">N = notes · A / purple border = audio.</text>
      <text x="480" y="255" class="muted">Eight slots are visible; four shown here.</text>
      <rect x="28" y="305" width="392" height="31" rx="4" fill="#272f3a" stroke="#697586" />
      <text x="41" y="325">LANE 1 ▾   SLOT 2 ▾   AUDIO CLIP   EDIT</text>
      <text x="480" y="309" class="number">4</text><text x="501" y="309">Inspect before recording</text>
      <text x="480" y="330" class="muted">Selectors do not launch or move an armed target.</text>
    {:else if view === 'notes'}
      <text x="28" y="29" class="heading">EDITOR · NOTES</text>
      <rect x="28" y="48" width="449" height="29" rx="4" fill="#29313b" />
      <text x="40" y="67">SCALE   16st   ⌫   ×2   DIV 1   SW 0   VEL   SCALE…</text>
      {#each Array(7) as _, row}
        {#each Array(16) as _, col}
          {@const on = row === 4 && col % 4 === 0 || row === 2 && col % 4 === 2 || row === 0 && col === 12}
          <rect x={42 + col * 27} y={101 + row * 24} width="24" height="21" rx="2" fill={on ? '#69c79e' : col === 6 ? '#444c59' : '#29313b'} stroke={col % 4 === 0 ? '#667580' : '#39424c'} />
        {/each}
      {/each}
      <text x="28" y="290" class="muted">← steps →                  pitch increases upward</text>
      <rect x="306" y="306" width="70" height="28" rx="4" fill="#224037" stroke="#6dcea2" />
      <rect x="387" y="306" width="86" height="28" rx="4" fill="#493d26" stroke="#dbb66e" />
      <text x="341" y="325" text-anchor="middle">NOW</text><text x="430" y="325" text-anchor="middle">QUEUE</text>
      <text x="509" y="70" class="number">1</text><text x="531" y="70">Clip tools</text>
      <text x="509" y="92" class="muted">Scale, length, division and velocity.</text>
      <text x="509" y="145" class="number">2</text><text x="531" y="145">Draw in the piano roll</text>
      <text x="509" y="167" class="muted">Click: add / remove.</text>
      <text x="509" y="189" class="muted">Shift-click or VEL: change velocity.</text>
      <text x="509" y="211" class="muted">Right-click a note: its note menu.</text>
      <text x="509" y="294" class="number">3</text><text x="531" y="294">Hear this clip</text>
      <text x="509" y="316" class="muted">NOW is immediate.</text>
      <text x="509" y="338" class="muted">QUEUE follows launch quantization.</text>
    {:else if view === 'audio'}
      <text x="28" y="29" class="heading">EDITOR · AUDIO</text>
      <text x="28" y="63">LANE 1 ▾   SLOT 2 ▾   AUDIO CLIP</text>
      <rect x="28" y="81" width="121" height="29" rx="4" fill="#594073" stroke="#bf93ef" />
      <rect x="158" y="81" width="117" height="29" rx="4" fill="#29313b" stroke="#667580" />
      <rect x="286" y="81" width="143" height="29" rx="4" fill="#29313b" stroke="#667580" />
      <text x="88" y="101" text-anchor="middle">RECORDED</text><text x="216" y="101" text-anchor="middle">LIVE INPUT</text><text x="357" y="101" text-anchor="middle">REPLACE TAKE…</text>
      <rect x="28" y="128" width="429" height="104" rx="4" fill="#222831" />
      {#each Array(68) as _, i}
        {@const height = 9 + Math.abs(Math.sin(i * 1.82) * Math.cos(i * .17)) * 76}
        <rect x={39 + i * 6} y={180 - height / 2} width="3" height={height} rx="1" fill="#b98ee8" />
      {/each}
      <rect x="28" y="251" width="72" height="29" rx="4" fill="#29313b" stroke="#67c297" /><text x="64" y="271" text-anchor="middle">NOW</text>
      <rect x="110" y="251" width="84" height="29" rx="4" fill="#29313b" stroke="#d2ad68" /><text x="152" y="271" text-anchor="middle">QUEUE</text>
      <text x="28" y="309" class="muted">REC target: lane 1, slot 2</text>
      <text x="28" y="333" class="muted">Capture: MIXMSTRS input 1 · playback: audio1 L/R</text>
      <text x="489" y="72" class="number">1</text><text x="511" y="72">Choose the source explicitly</text>
      <text x="489" y="94" class="muted">LIVE bypasses the recorded take.</text>
      <text x="489" y="116" class="muted">Launch an N slot to return to notes.</text>
      <text x="489" y="170" class="number">2</text><text x="511" y="170">See the saved take</text>
      <text x="489" y="192" class="muted">Waveform or media-availability status.</text>
      <text x="489" y="252" class="number">3</text><text x="511" y="252">Replace deliberately</text>
      <text x="489" y="274" class="muted">Confirmation comes before arming.</text>
      <text x="489" y="296" class="muted">The old take stays until the new one saves.</text>
    {:else}
      <text x="28" y="30" class="heading">TWO WAYS TO CAPTURE A PERFORMANCE</text>
      <text x="28" y="64" fill="#dbb66e">ARR · launch events</text>
      {#each Array(4) as _, lane}
        <rect x="28" y={78 + lane * 21} width="690" height="18" fill="#242c35" />
        <rect x={28 + lane * 34} y={80 + lane * 21} width={lane % 2 ? 310 : 204} height="14" rx="3" fill={colors[lane]} fill-opacity=".6" />
        <text x={38 + lane * 34} y={91 + lane * 21} class="tiny">slot {lane + 1}</text>
      {/each}
      <text x="28" y="187" class="muted">Records which clip launched, stopped or switched. Playback follows those clips.</text>
      <text x="28" y="222" fill="#78d2aa">SONG · printed notes</text>
      {#each Array(4) as _, row}
        <line x1="28" y1={240 + row * 19} x2="718" y2={240 + row * 19} stroke="#3b4652" />
        {#each Array(5) as _, note}
          <rect x={38 + note * 124 + row * 18} y={230 + row * 19} width={24 + row * 6} height="8" rx="2" fill={colors[row]} />
        {/each}
      {/each}
      <text x="28" y="336" class="muted">Records emitted MIDI notes, gates and velocity. Neither row records an audio waveform.</text>
    {/if}
  </svg>
  <figcaption>{titles[view]}. Illustrative layout; the guide below explains the actual controls.</figcaption>
</figure>

<style>
  .guide-figure { margin:1.2rem 0 1.8rem; }
  svg { display:block; width:100%; height:auto; border:1px solid var(--doc-border-dim,#29434a); border-radius:10px; }
  text { font-family:ui-sans-serif,system-ui,sans-serif; font-size:13px; fill:#eef1f6; }
  .heading { font-size:15px; font-weight:700; letter-spacing:.7px; }
  .muted { fill:#bac4d0; font-size:12px; }
  .tiny { font-size:10px; }
  .teal { fill:#67d1bc; }
  .number { fill:#91daeb; font-weight:800; }
  .leader { fill:none; stroke:#607586; }
  figcaption { color:var(--doc-fg-dim,#aab9be); font-size:.85em; margin-top:.5rem; }
</style>
