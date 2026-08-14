// packages/web/src/lib/docs/undeclared-edge-ledger.ts
//
// THE OPT-OUT LEDGER for the trigger/gate coherence check in
// `module-docs-lint.test.ts` — every GATE-CABLE port that has not yet declared
// `PortDef.edge`, named, with the total ratcheted in both directions.
//
// ── Why this file exists (the blind-gate finding, 2026-08-02) ────────────────
// The edge/gate vocabulary check opened with:
//
//     for (const { p, desc } of probes) {
//       if (!p.edge) continue;          // ← HERE
//
// A port with NO declaration was treated as NOT APPLICABLE. It is not: it is
// UNCHECKED. Same shape as a `<=` ceiling that can only trip by growing — the
// only ports the vocabulary gate could ever fail were the ones whose author had
// already done the work of declaring an edge, and the ports nobody declared
// (whose prose is therefore entirely unreviewed) were exactly the ones it
// skipped.
//
// MEASURED: the tree has **362 gate-cable ports**. **63** declare `edge` and
// were checked. **299** did not and were silently skipped — so the gate covered
// **17 %** of its subject and said nothing at all about the other 83 %.
// Deduplicated by `(module, portId)` — a handful of modules expose the same id
// as both an input and an output — that was the **291** pairs originally
// listed. **289** remain: treeohvox's `gate_in` / `accent_in` were drained
// when the gate's FALLING edge was wired up (it had never been read, so the
// gate's LENGTH was ignored outright) — declaring the semantic and making it
// true landed in the same change.
//
// And the vocabulary really is unreviewed on them: **295 of the 299** carry
// authored doc prose that ALREADY uses trigger or gate vocabulary. The docs say
// which semantic each port has; only the contract is silent.
//
// ── Deny by default ─────────────────────────────────────────────────────────
// A gate-cable port now passes only if it declares `edge`, or is named here.
// A NEW gate port with no declaration is RED. The total is asserted in BOTH
// directions (`actual <= CEILING` and `CEILING - actual === 0`), so declaring
// an edge without lowering the number is red rather than silent slack.
// A stale entry — a module/port that has since declared `edge`, or that no
// longer exists — is RED too: the metric is anchored to the DEFS, not to this
// list.
//
// ── How an entry is drained ─────────────────────────────────────────────────
// Declaring `edge` is a CONTRACT change: `contract-signature.ts` emits
// `edge=<v>`, so it re-pins `contract-lock.txt` and needs a `task docs:accept`.
// That is why this ledger is not drained in the PR that created it — folding a
// contract re-pin into a gate PR is exactly the mixing this repo's standards
// forbid. Drain per module, deliberately, and lower the ceiling in the same
// commit.
//
// ⚠ THE ONE ENTRY THAT ALREADY HAS AN IN-SOURCE TODO IS `qbrt.ping`. Its own
// def header says: *"CONTRACT GAP: the PortDef below does NOT yet declare
// `edge: 'trigger'` even though qbrt.dsp:14 is a textbook rising-edge
// detector, so the jack renders without the trigger glyph"*, and its authored
// doc prose opens *"The excitation TRIGGER."* The comment, the DSP and the docs
// all agree; only the contract is silent — and the gate whose job was to notice
// that was the one skipping it (face-redo ledger defect #12).

/** `moduleType` → port ids on a `gate` cable that do not declare `edge`. */
export const UNDECLARED_EDGE_DEBT: Readonly<Record<string, readonly string[]>> = {
  bluebox: ['gate_0', 'gate_1', 'gate_2', 'gate_3', 'gate_4', 'gate_5', 'gate_6', 'gate_7', 'gate_8', 'gate_9', 'gate_bluebox', 'gate_redbox'],
  buggles: ['burst', 'clock', 'external_clock'],
  cartesian: ['clock', 'gate', 'lfo_clock'],
  clipplayer: ['gate1', 'gate2', 'gate3', 'gate4', 'gate5', 'gate6', 'gate7', 'gate8'],
  clouds: ['freeze_gate'],
  cube: ['trigger'],
  doom: ['evt_door', 'evt_gun_p1', 'evt_gun_p2', 'evt_gun_p3', 'evt_gun_p4', 'evt_kill', 'evt_kill_arachnotron', 'evt_kill_baron', 'evt_kill_caco', 'evt_kill_chainguy', 'evt_kill_cyber', 'evt_kill_demon', 'evt_kill_imp', 'evt_kill_keen', 'evt_kill_knight', 'evt_kill_lostsoul', 'evt_kill_mancubus', 'evt_kill_pain', 'evt_kill_revenant', 'evt_kill_shotguy', 'evt_kill_spectre', 'evt_kill_spidermind', 'evt_kill_vile', 'evt_kill_wolfss', 'evt_kill_zombieman', 'evt_p1_dies', 'evt_p2_dies', 'evt_p3_dies', 'evt_p4_dies'],
  drummergirl: ['gate'],
  drumseqz: ['clock', 'gate1', 'gate2', 'gate3', 'gate4', 'play_cv', 'queue1_cv', 'queue2_cv', 'queue3_cv', 'queue4_cv', 'reset_cv'],
  flipper: ['flip', 'flop', 'in1', 'in2'],
  fourplexer: ['gate1', 'gate2', 'gate3', 'gate4'],
  frogger: ['dead_gate', 'down_gate', 'home_gate', 'left_gate', 'level_gate', 'right_gate', 'start_gate', 'up_gate'],
  gamepad: ['a', 'b', 'back', 'dd', 'dl', 'dr', 'du', 'lb', 'rb', 'start', 'x', 'y'],
  gibribbon: ['a', 'b', 'clock', 'evt_fire', 'evt_gameover', 'evt_hit', 'evt_kill', 'evt_miss', 'gate', 'x_btn', 'y_btn'],
  illogic: ['and', 'nand', 'not', 'or'],
  kria: ['gate1', 'gate2', 'gate3', 'gate4'],
  macrooscillator: ['trig'],
  macseq: ['clock', 'gate', 'next_cv', 'play_cv', 'prev_cv', 'queue1_cv', 'queue2_cv', 'queue3_cv', 'queue4_cv', 'queue5_cv', 'queue6_cv', 'queue7_cv', 'queue8_cv', 'random_cv', 'reset_cv'],
  marbles: ['clk', 't1', 't2'],
  midiCvBuddy: ['gate'],
  midiLane: ['gate', 'note_gate'],
  midiOutBuddy: ['gate'],
  midiclock: ['clock', 'midistart', 'midistop'],
  modtris: ['drop_fast', 'line_cleared', 'move_l', 'move_r', 'overfill', 'rotate_l', 'rotate_r'],
  moog911: ['gate'],
  moog911a: ['out1', 'out2', 'trig1', 'trig2'],
  moog912: ['gate'],
  moog956: ['gate'],
  moog960: ['clock', 'clock_out', 'start', 'stop'],
  moog961: ['s_in', 's_out_a', 's_out_b', 'v_in_a', 'v_in_b', 'v_out1', 'v_out2'],
  moog962: ['shift'],
  moog993: ['trig_from1', 'trig_from2', 'trig_out1', 'trig_out2', 'trig_out3'],
  nibbles: ['death', 'dir_change', 'pellet'],
  numpadPlus: ['clock', 'l1_gate', 'l2_gate', 'l3_gate', 'l4_gate'],
  outlines: ['collide', 'gate'],
  picturebox: ['asset_gate'],
  polyseqz: ['clock', 'gate', 'play_cv', 'queue1_cv', 'queue2_cv', 'queue3_cv', 'queue4_cv', 'reset_cv'],
  pong: ['score_left', 'score_right'],
  qbrt: ['ping'],
  rings: ['strum'],
  sampleHold: ['gate_in'],
  samsloop: ['trig'],
  score: ['clock', 'gate', 'play_cv', 'queue1_cv', 'queue2_cv', 'queue3_cv', 'queue4_cv', 'reset_cv'],
  sequencer: ['clock', 'gate', 'next_cv', 'play_cv', 'prev_cv', 'queue1_cv', 'queue2_cv', 'queue3_cv', 'queue4_cv', 'queue5_cv', 'queue6_cv', 'queue7_cv', 'queue8_cv', 'random_cv', 'reset_cv'],
  shapegen: ['clock_in'],
  skifree: ['gate'],
  slewSwitch: ['eoc', 'reset', 'step_clock'],
  synesthesia: ['a_band1_gate', 'a_band1_trig', 'a_band2_gate', 'a_band2_trig', 'a_band3_gate', 'a_band3_trig', 'a_band4_gate', 'a_band4_trig', 'b_band1_gate', 'b_band1_trig', 'b_band2_gate', 'b_band2_trig', 'b_band3_gate', 'b_band3_trig', 'b_band4_gate', 'b_band4_trig'],
  timelorde: ['1/12', '1/16', '1/2', '1/3', '1/32', '1/4', '1/64', '1/8', '1x', '2x', '4x', '8x', 'clock', 'start_in', 'stop_in', 'swing'],
  twotracks: ['overdub_a', 'overdub_b', 'rec_arm_a', 'rec_arm_b', 'rec_start_a', 'rec_start_b'],
  vfpgaRunner: ['g1', 'g2', 'g3', 'g4'],
  videobox: ['play_trigger'],
  videovarispeed: ['asset_gate', 'cv_loop_toggle', 'cv_pause', 'cv_reset', 'cv_start'],
  wavecel: ['trigger'],
  wavesculpt: ['gate1', 'gate2', 'gate3', 'gate4'],
  writeseq: ['clock', 'gate', 'play_cv', 'queue1_cv', 'queue2_cv', 'queue3_cv', 'queue4_cv', 'rec', 'reset_cv'],
};

/**
 * The `(module, port)` pairs still owed an `edge` declaration, as a RATCHET PIN
 * — `<count>@<digest of the exact set>` (see `$lib/dev/ratchet-pin`).
 * ⚠ ONLY SHRINKS, asserted from BOTH sides in module-docs-lint.test.ts.
 *
 * 289 → 288 (2026-08-08): meowbox's `gate` declared `edge: 'gate'`. It is the
 * case this ledger's header is about — the def's own prose said "responds to
 * the edge, not how long the level stays up" over an `en.adsr` sustaining at
 * 0.4, and the skipped vocabulary check could not see the contradiction.
 *
 * ⚠ WHY THIS IS NOT A BARE INTEGER ANY MORE. It was `= 288`, and on 2026-08-09
 * a branch draining bluebox's 12 gate ports and a branch draining meowbox's one
 * BOTH inherited 289 and wrote their own answer. Their entry deletions were
 * lines apart, so the lists merged cleanly; the ceiling line took one side's
 * value in silence and NEITHER number described the merge (the truth was 276).
 * A count cannot express WHICH pairs it counted, so git had nothing to conflict
 * on. The digest can, and does. To accept a drain: run module-docs-lint and
 * paste the pin the failure prints.
 */
export const UNDECLARED_EDGE_PIN = '288@ac220c4b';

/** Flattened `module.port` pairs (the countable form). */
export function undeclaredEdgePairs(): string[] {
  const out: string[] = [];
  for (const [type, ids] of Object.entries(UNDECLARED_EDGE_DEBT)) {
    for (const id of ids) out.push(`${type}.${id}`);
  }
  return out.sort();
}
