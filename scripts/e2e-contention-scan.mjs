// scripts/e2e-contention-scan.mjs
//
// CONTENTION CLASSES, DERIVED AT PLAN TIME — never committed (#1600).
//
// The e2e shard planner spreads each contention class across shards before
// cost-packing (see e2e-shard-plan.mjs PASS 1 — the camera-input 3/3 failure).
// The class map used to live INSIDE `e2e-timings.generated.json`, derived by a
// scan that ran ONCE and was never committed. A committed snapshot of a
// derivation IS a hand-maintained list from the moment the population moves:
// `layers-survive-card-collapse.spec.ts` (262 CPU-s of video decode) landed
// after the snapshot, joined no class, and was cost-packed next to other media
// specs — the exact contention shape the class exists to prevent, recreated by
// artifact staleness instead of packing logic.
//
// So the scan now runs EVERY TIME the planner does (it is ~10 ms over ~430
// files), and the committed artifact carries only the COSTS — the one thing
// that genuinely requires a CI run to know. A new media spec is classified the
// moment it exists, with no accept step in between.
//
// ── WHAT COUNTS AS 'media' ──────────────────────────────────────────────────
// A spec whose SOURCE shows it decodes/captures real media in the page:
// getUserMedia / MediaStream use, a <video> element or video testid, loading a
// media fixture (.webm/.mp4/.wav), or enrolment in the fake-camera/fake-mic
// Playwright projects. These are the specs that compete for decoder threads
// and the single fake capture device when co-scheduled — DOM-only specs do
// not, however expensive they are.
//
// ⚠ SOURCE-TEXT MARKERS, deliberately. This reads the spec as text rather than
// executing it, so a marker inside a comment DOES classify the file. That is
// the safe direction: over-classifying costs a little balance; under-
// classifying costs a required lane (camera-input failed 3/3). State the
// scope: what this scan structurally cannot see is media use hidden behind a
// helper in another file with no marker in the spec itself — name the marker
// in the spec (or the helper import below) if you build such a helper.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Substring markers, checked against the spec's SOURCE TEXT.
 *
 *  Calibrated against the class's own failure stories, not against the stale
 *  committed snapshot (which omitted 4 of the 5 specs its OWN comment names as
 *  camera-input's fatal co-tenants). The principle: a marker must indicate the
 *  page DECODES, CAPTURES or ENCODES real media — competing for decoder
 *  threads, the fake capture device, or an encoder — not merely that the spec
 *  renders WebGL or mentions timing. (`currentTime`/`camera`/`.wav` were tried
 *  and rejected: they sweep in DOM/WebGL specs and dilute PASS 1's round-robin
 *  until it displaces the cost packing.) */
export const MEDIA_MARKERS = [
  'getUserMedia',
  'MediaStream',
  'mediaDevices',
  '<video',
  'HTMLVideoElement',
  'VideoFrame',
  'VideoEncoder',
  '.webm',
  '.mp4',
];

// ── WHAT COUNTS AS 'audio' ──────────────────────────────────────────────────
// A spec that asserts AUDIBLE OUTPUT through a live analyser read: the page
// renders audio in REAL TIME and the spec samples an observation window
// expecting non-silence (an RMS/peak floor, or a held CV level). Duration is
// not the hazard — the render thread is. Co-scheduled audio graphs at 4
// workers compete for CPU with each other and with the sampling poll; a
// starved graph underruns, the window reads 0.0000, and the assertion fails
// on a page whose patch is perfectly correct. Cost packing CONCENTRATES these
// (expensive specs cluster under LPT because they are expensive), which is
// the same shape that killed camera-input 3/3 — so they get PASS 1's spread.
//
// Markers are the two shared seams every audible assertion goes through —
// derived membership, never a hand-typed list (#1600's lesson):
//   · readScopePeakOverWindow — the _module-coverage-helpers window read
//     whose `.rms`/`.peak` the spec asserts against a floor
//   · ch1_last_sample — the raw SCOPE analyser channel specs poll directly
//     via the engine hook (e.g. snh-hold's held-V/oct min-over-window)
// If you build a new audible-read helper, name one of these markers in the
// spec (or add the helper here) — same rule as the media note above.
export const AUDIO_MARKERS = ['readScopePeakOverWindow', 'ch1_last_sample'];

/**
 * Scan a directory of Playwright specs and classify each into a contention
 * class: 'media' or 'audio' today; the shape leaves room for more.
 *
 * A file joins ONE class. Where both match, 'media' wins: the fake capture
 * device / decoder-thread fight is the class that reddened a required lane
 * 3/3, its spread must stay stable, and a media spec's audio graph is spread
 * anyway by the media round-robin itself.
 *
 * @param {string} dir absolute path to the spec directory
 * @returns {Record<string, 'media' | 'audio'>} basename -> class
 */
export function scanContention(dir = join(ROOT, 'e2e/tests')) {
  /** @type {Record<string, 'media' | 'audio'>} */
  const out = {};
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.spec.ts')) continue;
    const src = readFileSync(join(dir, f), 'utf8');
    if (MEDIA_MARKERS.some((m) => src.includes(m))) out[f] = 'media';
    else if (AUDIO_MARKERS.some((m) => src.includes(m))) out[f] = 'audio';
  }
  return out;
}

const isMain =
  typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('e2e-contention-scan.mjs');

if (isMain) {
  const map = scanContention();
  /** @type {Record<string, string[]>} */
  const byClass = {};
  for (const [f, c] of Object.entries(map)) (byClass[c] ??= []).push(f);
  for (const [c, members] of Object.entries(byClass).sort()) {
    console.log(`${members.length} spec(s) classified '${c}':`);
    for (const f of members) console.log(`  ${f}`);
  }
}
