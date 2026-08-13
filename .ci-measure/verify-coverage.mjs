import { readFileSync, writeFileSync } from 'node:fs';
import { parseRunLog, compare } from '../scripts/vrt-shard-coverage.mjs';

const log = readFileSync('.ci-measure/vrt-strict.log', 'utf8');
const planned = Object.keys(JSON.parse(readFileSync('e2e/vrt-strict-timings.generated.json', 'utf8')).tests);

// POSITIVE: the real CI log against the real roster.
let { ran, skipped } = parseRunLog(log);
let r = compare(planned, ran, skipped);
console.log('positive  ok=%s executed=%d missing=%d extra=%d skipped=%d', r.ok, ran.size, r.missing.length, r.extra.length, r.skipped.length);

// NEGATIVE 1: drop one ✓ line from the log — the check must go red and NAME it.
const dropped = log.split('\n').filter((l) => !/adsr card matches baseline \(/.test(l)).join('\n');
({ ran, skipped } = parseRunLog(dropped));
r = compare(planned, ran, skipped);
console.log('neg-drop  ok=%s missing=%j', r.ok, r.missing);

// NEGATIVE 2: turn one ✓ into a skip marker — a skip must NOT read as a pass.
const skippedLog = log.replace(/✓(\s+\d+ \[chromium-vrt\] › vrt\/vrt\.spec\.ts:\d+:\d+ › [^\n]*buggles card matches baseline)[^\n]*/, '-$1');
({ ran, skipped } = parseRunLog(skippedLog));
r = compare(planned, ran, skipped);
console.log('neg-skip  ok=%s skipped=%j missing=%j', r.ok, r.skipped, r.missing);

// NEGATIVE 3: an EXTRA executed test the plan never asked for.
r = compare(planned.slice(1), parseRunLog(log).ran, []);
console.log('neg-extra ok=%s extra=%j', r.ok, r.extra);

// Harvested durations must match the committed artifact (the parser is the
// same one that produced it) — a silent parser change would show up here.
const harvested = Object.fromEntries([...parseRunLog(log).ran]);
const committed = JSON.parse(readFileSync('e2e/vrt-strict-timings.generated.json', 'utf8')).tests;
const diff = planned.filter((k) => Math.abs((harvested[k] ?? -1) - committed[k]) > 1e-6);
console.log('roundtrip mismatches=%d', diff.length);
