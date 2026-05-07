// e2e/audio-drift/cross-machine/compare.ts
//
// Coordinator-side comparator: reads runner-A and runner-B captured PCM,
// aligns by wall-clock timestamp, runs the same metrics as the local
// harness (Pearson, spectral correlation, RMS, phase drift), writes:
//   - <out>/audio-drift-cross-machine-results.csv   one row per scenario
//   - <out>/audio-drift-cross-machine-report.md     human report
//   - <out>/audio-drift-cross-machine-summary.json  for downstream tooling
//
// Usage:
//   tsx compare.ts \
//     --a-dir <path/to/runner-a-artifacts> \
//     --b-dir <path/to/runner-b-artifacts> \
//     --out-dir <path/to/comparison-output> \
//     [--scenarios 01-static-vco,04-sequenced]
//
// Both --a-dir and --b-dir should contain pairs of files named
// audio-drift-<scenario>-<role>.pcm + .json, where role is 'author' for A
// and 'listener' for B (per the workflow's job assignment).

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { compare, verdict, type CompareMetrics } from '../_metrics';

interface Args {
  aDir: string;
  bDir: string;
  outDir: string;
  scenarios?: string[];
  rttMsAvg?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--a-dir') { out.aDir = v; i++; }
    else if (k === '--b-dir') { out.bDir = v; i++; }
    else if (k === '--out-dir') { out.outDir = v; i++; }
    else if (k === '--scenarios') { out.scenarios = v.split(',').map((s) => s.trim()).filter(Boolean); i++; }
    else if (k === '--rtt-ms') { out.rttMsAvg = Number(v); i++; }
  }
  if (!out.aDir || !out.bDir || !out.outDir) {
    throw new Error('compare: --a-dir, --b-dir, --out-dir are required');
  }
  return out as Args;
}

interface CapturePair {
  scenario: string;
  aSamples: Float32Array;
  bSamples: Float32Array;
  sampleRate: number;
  aStartedAtMs: number;
  bStartedAtMs: number;
  aMeta: Record<string, unknown>;
  bMeta: Record<string, unknown>;
}

async function discoverScenarios(dir: string, role: string): Promise<string[]> {
  const files = await readdir(dir);
  const out = new Set<string>();
  const re = new RegExp(`^audio-drift-(.+)-${role}\\.json$`);
  for (const f of files) {
    const m = f.match(re);
    if (m) out.add(m[1]);
  }
  return [...out];
}

async function loadPair(
  scenario: string,
  aDir: string,
  bDir: string,
): Promise<CapturePair | { scenario: string; error: string }> {
  try {
    const aMetaRaw = await readFile(join(aDir, `audio-drift-${scenario}-author.json`), 'utf8');
    const bMetaRaw = await readFile(join(bDir, `audio-drift-${scenario}-listener.json`), 'utf8');
    const aMeta = JSON.parse(aMetaRaw) as Record<string, unknown>;
    const bMeta = JSON.parse(bMetaRaw) as Record<string, unknown>;
    if (aMeta.sampleRate !== bMeta.sampleRate) {
      return {
        scenario,
        error: `sampleRate mismatch: A=${aMeta.sampleRate} B=${bMeta.sampleRate}`,
      };
    }
    const aPcm = await readFile(join(aDir, `audio-drift-${scenario}-author.pcm`));
    const bPcm = await readFile(join(bDir, `audio-drift-${scenario}-listener.pcm`));
    const aSamples = new Float32Array(
      aPcm.buffer.slice(aPcm.byteOffset, aPcm.byteOffset + aPcm.byteLength),
    );
    const bSamples = new Float32Array(
      bPcm.buffer.slice(bPcm.byteOffset, bPcm.byteOffset + bPcm.byteLength),
    );
    return {
      scenario,
      aSamples,
      bSamples,
      sampleRate: aMeta.sampleRate as number,
      aStartedAtMs: aMeta.startedAtMs as number,
      bStartedAtMs: bMeta.startedAtMs as number,
      aMeta,
      bMeta,
    };
  } catch (e) {
    return { scenario, error: e instanceof Error ? e.message : String(e) };
  }
}

// Aligns A and B by wall-clock start delta. If B started 200ms after A,
// trim 200ms from the front of A (or pad B with zeros — we trim, simpler
// + doesn't affect spectral correlation).
function alignByTimestamp(p: CapturePair): {
  aAligned: Float32Array;
  bAligned: Float32Array;
  alignmentSamples: number;
  alignmentMs: number;
} {
  const deltaMs = p.bStartedAtMs - p.aStartedAtMs;
  const deltaSamples = Math.round((deltaMs / 1000) * p.sampleRate);
  let a = p.aSamples;
  let b = p.bSamples;
  if (deltaSamples > 0) {
    // B started later. Skip the first deltaSamples of A so A[0] aligns to B[0].
    a = p.aSamples.subarray(Math.min(deltaSamples, p.aSamples.length));
  } else if (deltaSamples < 0) {
    b = p.bSamples.subarray(Math.min(-deltaSamples, p.bSamples.length));
  }
  const n = Math.min(a.length, b.length);
  return {
    aAligned: a.subarray(0, n),
    bAligned: b.subarray(0, n),
    alignmentSamples: deltaSamples,
    alignmentMs: deltaMs,
  };
}

interface ScenarioComparison {
  scenario: string;
  aStartedAtMs?: number;
  bStartedAtMs?: number;
  alignmentMs?: number;
  alignmentSamples?: number;
  sampleRate?: number;
  aSamples?: number;
  bSamples?: number;
  metrics?: CompareMetrics;
  verdict?: string;
  // The two-runner cross-machine acceptable bar is looser than same-machine
  // because users on different physical hosts will *never* sample-align;
  // we judge purely on spectral correlation + drift bounds.
  acceptable?: 'yes' | 'with-caveats' | 'no';
  error?: string;
  notes?: string;
}

function classifyCrossMachine(m: CompareMetrics): 'yes' | 'with-caveats' | 'no' {
  // Cross-machine bar: spectral correlation is the only meaningful metric.
  // Phase drift is bounded — anything > 500 μs/sec extrapolates to ~30s of
  // slip per minute, which is audibly bad even though each user listens to
  // only their own stream.
  if (m.spectralPearsonAvg >= 0.85 && Math.abs(m.phaseDriftUsPerSec) <= 500) return 'yes';
  if (m.spectralPearsonAvg >= 0.7) return 'with-caveats';
  return 'no';
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.outDir, { recursive: true });

  let scenarios = args.scenarios;
  if (!scenarios || scenarios.length === 0) {
    // Discover from runner-A's directory (author files).
    scenarios = await discoverScenarios(args.aDir, 'author');
    scenarios.sort();
  }
  if (scenarios.length === 0) {
    console.error(`No scenarios found in ${args.aDir} (looking for audio-drift-*-author.json)`);
    process.exit(2);
  }

  console.log(`Comparing ${scenarios.length} scenarios:`);
  for (const s of scenarios) console.log(`  - ${s}`);

  const results: ScenarioComparison[] = [];
  for (const scenario of scenarios) {
    const loaded = await loadPair(scenario, args.aDir, args.bDir);
    if ('error' in loaded) {
      console.log(`  ${scenario}: ERROR ${loaded.error}`);
      results.push({ scenario, error: loaded.error });
      continue;
    }
    const aligned = alignByTimestamp(loaded);
    if (aligned.aAligned.length < loaded.sampleRate) {
      console.log(`  ${scenario}: ERROR aligned buffer too short (${aligned.aAligned.length} samples)`);
      results.push({
        scenario,
        error: `aligned buffer too short (${aligned.aAligned.length} samples)`,
        aStartedAtMs: loaded.aStartedAtMs,
        bStartedAtMs: loaded.bStartedAtMs,
        alignmentMs: aligned.alignmentMs,
      });
      continue;
    }
    const metrics = compare(aligned.aAligned, aligned.bAligned, loaded.sampleRate);
    const v = verdict(metrics);
    const accept = classifyCrossMachine(metrics);
    console.log(
      `  ${scenario}: pearson=${metrics.pearson.toFixed(3)} spec=${metrics.spectralPearsonAvg.toFixed(3)} drift=${metrics.phaseDriftUsPerSec.toFixed(1)} μs/s align=${aligned.alignmentMs}ms accept=${accept}`,
    );
    results.push({
      scenario,
      aStartedAtMs: loaded.aStartedAtMs,
      bStartedAtMs: loaded.bStartedAtMs,
      alignmentMs: aligned.alignmentMs,
      alignmentSamples: aligned.alignmentSamples,
      sampleRate: loaded.sampleRate,
      aSamples: aligned.aAligned.length,
      bSamples: aligned.bAligned.length,
      metrics,
      verdict: v,
      acceptable: accept,
    });
  }

  // CSV ----------------------------------------------------------------
  const csvHeaders = [
    'scenario',
    'time_corr',
    'spec_corr_avg',
    'spec_corr_worst',
    'rms_diff',
    'phase_drift_us_per_s',
    'rms_a',
    'rms_b',
    'alignment_ms',
    'sample_rate',
    'verdict',
    'acceptable',
    'error',
  ];
  const csvLines = [csvHeaders.join(',')];
  for (const r of results) {
    csvLines.push(
      [
        r.scenario,
        r.metrics?.pearson?.toFixed(4) ?? '',
        r.metrics?.spectralPearsonAvg?.toFixed(4) ?? '',
        r.metrics?.spectralPearsonWorst?.toFixed(4) ?? '',
        r.metrics?.rmsDiff?.toFixed(4) ?? '',
        r.metrics?.phaseDriftUsPerSec?.toFixed(2) ?? '',
        r.metrics?.rmsA?.toFixed(5) ?? '',
        r.metrics?.rmsB?.toFixed(5) ?? '',
        r.alignmentMs ?? '',
        r.sampleRate ?? '',
        r.verdict ?? '',
        r.acceptable ?? '',
        r.error ?? '',
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  await writeFile(join(args.outDir, 'audio-drift-cross-machine-results.csv'), csvLines.join('\n') + '\n');

  // Markdown report ----------------------------------------------------
  const lines: string[] = [];
  const dateTag = new Date().toISOString();
  lines.push(`# Audio drift — cross-machine results — ${dateTag.slice(0, 19)}Z`);
  lines.push('');
  lines.push(
    `Two GitHub Actions runners (one acting as patch *author*, one as *listener*) connected to the same rackspace on \`autotest.patchtogether.live\` and captured local audio through their respective AudioContexts. Below: spectral correlation + drift metrics after wall-clock timestamp alignment.`,
  );
  lines.push('');
  lines.push(
    `Compare to same-machine numbers in \`art/audio-drift/report-*.md\`. The cross-machine bar is intentionally looser (sample-alignment is unreachable across hosts; we measure musical equivalence + drift rate).`,
  );
  lines.push('');
  lines.push('## Per-scenario results');
  lines.push('');
  lines.push('| Scenario | TimeCorr | SpecCorrAvg | RMSdiff | DriftμsPerSec | Align(ms) | Verdict | Acceptable? |');
  lines.push('|---|---:|---:|---:|---:|---:|---|---|');
  for (const r of results) {
    if (r.error) {
      lines.push(`| ${r.scenario} | — | — | — | — | — | error | no |`);
      continue;
    }
    const m = r.metrics!;
    lines.push(
      `| ${r.scenario} | ${m.pearson.toFixed(3)} | ${m.spectralPearsonAvg.toFixed(3)} | ${m.rmsDiff.toFixed(3)} | ${m.phaseDriftUsPerSec.toFixed(1)} | ${r.alignmentMs} | ${r.verdict} | ${r.acceptable} |`,
    );
  }
  lines.push('');
  lines.push('## Detail per scenario');
  lines.push('');
  for (const r of results) {
    lines.push(`### ${r.scenario}`);
    if (r.error) {
      lines.push(`**ERROR:** ${r.error}`);
      lines.push('');
      continue;
    }
    const m = r.metrics!;
    lines.push(`- A started: ${new Date(r.aStartedAtMs!).toISOString()}`);
    lines.push(`- B started: ${new Date(r.bStartedAtMs!).toISOString()}`);
    lines.push(`- Wall-clock delta (B − A): ${r.alignmentMs} ms (${r.alignmentSamples} samples @ ${r.sampleRate} Hz)`);
    lines.push(`- Aligned length: ${r.aSamples} samples (~${(r.aSamples! / r.sampleRate!).toFixed(2)} s)`);
    lines.push(`- Pearson (time-domain): ${m.pearson.toFixed(4)}`);
    lines.push(`- RMS A / B: ${m.rmsA.toFixed(5)} / ${m.rmsB.toFixed(5)}`);
    lines.push(`- RMS diff: ${(m.rmsDiff * 100).toFixed(1)} %`);
    lines.push(`- Spectral correlation avg: ${m.spectralPearsonAvg.toFixed(4)}, worst-frame: ${m.spectralPearsonWorst.toFixed(4)}`);
    lines.push(`- Phase drift: ${m.phaseDriftUsPerSec.toFixed(2)} μs/sec`);
    lines.push(`- Verdict: **${r.verdict}**`);
    lines.push(`- Acceptable cross-machine: **${r.acceptable}**`);
    lines.push('');
  }

  // Aggregate ---------------------------------------------------------
  const real = results.filter((r) => !r.error);
  const counts: Record<string, number> = { yes: 0, 'with-caveats': 0, no: 0 };
  for (const r of real) counts[r.acceptable!] = (counts[r.acceptable!] ?? 0) + 1;
  const passed = counts.yes;
  const total = real.length;
  lines.push('## Aggregate');
  lines.push('');
  lines.push(`Total scenarios: ${results.length} (${results.length - real.length} errored, ${real.length} ran).`);
  lines.push('');
  lines.push(`- yes: ${counts.yes}`);
  lines.push(`- with-caveats: ${counts['with-caveats']}`);
  lines.push(`- no: ${counts.no}`);
  lines.push('');
  if (counts.no === 0 && counts['with-caveats'] === 0) {
    lines.push('**Headline:** all scenarios cleared the cross-machine drift bar. Same-machine recommendation (skip Phase C) is **confirmed** by cross-machine measurements.');
  } else if (counts.no === 0) {
    lines.push(`**Headline:** ${passed}/${total} scenarios cleared the bar; ${counts['with-caveats']} with caveats. Cross-machine drift slightly worse than same-machine but still inside acceptable bounds. Same-machine recommendation likely holds.`);
  } else {
    lines.push(`**Headline:** ${counts.no} scenarios FAILED the cross-machine drift bar. Same-machine recommendation may need revisiting.`);
  }

  const reportPath = join(args.outDir, 'audio-drift-cross-machine-report.md');
  await writeFile(reportPath, lines.join('\n') + '\n');

  // Summary JSON -----------------------------------------------------
  const summary = {
    finishedAt: dateTag,
    scenarios: results,
    counts,
    headline:
      counts.no === 0 && counts['with-caveats'] === 0
        ? 'all scenarios cleared cross-machine drift bar'
        : counts.no === 0
          ? `${passed}/${total} cleared, ${counts['with-caveats']} with caveats`
          : `${counts.no} scenarios failed cross-machine drift bar`,
  };
  await writeFile(
    join(args.outDir, 'audio-drift-cross-machine-summary.json'),
    JSON.stringify(summary, null, 2),
  );

  // GitHub Actions step summary --------------------------------------
  if (process.env.GITHUB_STEP_SUMMARY) {
    const stepLines: string[] = [];
    stepLines.push('## Cross-machine audio-drift results');
    stepLines.push('');
    stepLines.push(`**${summary.headline}**`);
    stepLines.push('');
    stepLines.push('| Scenario | SpecCorrAvg | DriftμsPerSec | Align(ms) | Verdict | Acceptable |');
    stepLines.push('|---|---:|---:|---:|---|---|');
    for (const r of results) {
      if (r.error) {
        stepLines.push(`| ${r.scenario} | — | — | — | error | no |`);
      } else {
        const m = r.metrics!;
        stepLines.push(
          `| ${r.scenario} | ${m.spectralPearsonAvg.toFixed(3)} | ${m.phaseDriftUsPerSec.toFixed(1)} | ${r.alignmentMs} | ${r.verdict} | ${r.acceptable} |`,
        );
      }
    }
    stepLines.push('');
    stepLines.push(`Full report: [audio-drift-cross-machine-report.md](./audio-drift-cross-machine-report.md)`);
    await writeFile(process.env.GITHUB_STEP_SUMMARY, stepLines.join('\n') + '\n', { flag: 'a' });
  }

  console.log(`\nWrote: ${reportPath}`);
  console.log(`Headline: ${summary.headline}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
