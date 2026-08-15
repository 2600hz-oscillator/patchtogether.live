#!/usr/bin/env node
/**
 * scripts/lint/shellcheck-gate.mjs — the shell half of `task lint` (issue #1504).
 *
 * BEFORE THIS: no shell in this repository was ever linted. `actionlint` ran
 * with `-shellcheck=` — the flag that DISABLES its shellcheck integration — so
 * the thousands of lines of embedded shell inside `.github/workflows/**` `run:`
 * blocks (the scripts that decide what gates and what deploys) were checked for
 * GitHub Actions syntax only. Standalone `.sh` scripts under `scripts/` had no linter at all.
 *
 * NOW: two surfaces, both deny-by-default.
 *   - THIS FILE lints every tracked `*.sh` at `--severity=style`, the strictest
 *     setting, and requires ZERO findings. Not "few", not "no new ones" — zero.
 *     The tree was already almost clean, so a ceiling would have been a
 *     mechanism with nothing to do except go stale (CLAUDE.md: prefer the
 *     unconditional assertion; a ceiling of N measures nothing).
 *   - `task actionlint` now runs WITH the shellcheck integration, which
 *     substitutes GitHub expressions and hands each `run:` body to the same
 *     pinned binary. That is why the `-shellcheck=` flag is gone.
 *
 * EXEMPTIONS ARE PER-INSTANCE AND CARRY A REASON. shellcheck's own
 * `# shellcheck disable=SCxxxx` directive is the mechanism — it names the exact
 * code at the exact line, so an unrelated new defect on the same line still
 * reddens. This gate additionally requires every such directive in the tree to
 * carry a `why:`, because a bare code is a decision with its reasoning thrown
 * away. There is no file-level opt-out and no ignore list.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHELLCHECK = process.env.SHELLCHECK_BIN ?? path.join(ROOT, 'node_modules/.cache/shellcheck/shellcheck');

/** Strictest severity shellcheck offers. Anything less is a choice to not look. */
const SEVERITY = 'style';

/**
 * PERMANENT CONTROLS — both directions, on every run.
 *
 * `task lint` is the only thing standing between a broken deploy script and
 * main, so "did the linter actually run" cannot be assumed from a zero-finding
 * result: a shellcheck that fails to parse, or is handed an empty file list,
 * reports zero findings and exits 0. Indistinguishable from a clean tree, which
 * is exactly the failure mode CLAUDE.md calls out — "frozen" and "never looked"
 * look identical from the output.
 *
 * Each case pins the SPECIFIC code expected, not merely "something was
 * reported", so a linter that has started reporting the wrong thing is red too.
 */
const CONTROLS = [
  {
    name: 'must report an unquoted expansion',
    code: '#!/usr/bin/env bash\nf() {\n  local x="$1"\n  cat $x\n}\n',
    mustReport: 'SC2086',
  },
  {
    name: 'must report a cd without a guard',
    code: '#!/usr/bin/env bash\ncd /tmp\nrm -f ./scratch\n',
    mustReport: 'SC2164',
  },
  {
    name: 'must honour a disable directive',
    code: '#!/usr/bin/env bash\nf() {\n  local x="$1"\n  # shellcheck disable=SC2086\n  cat $x\n}\n',
    mustBeSilent: true,
  },
  {
    name: 'must be silent on clean shell',
    code: '#!/usr/bin/env bash\nset -euo pipefail\nf() {\n  local x="$1"\n  cat "$x"\n}\nf "$@"\n',
    mustBeSilent: true,
  },
];

/**
 * What this gate structurally CANNOT see. Printed on every run, green ones
 * included — a reader of a passing log is entitled to know the limits of what
 * just passed.
 */
const BLIND_SPOTS = [
  'TASKFILE SHELL. `Taskfile.yml` `cmds:` blocks are shell, but go-template first: `{{.WEB}}` is not shell syntax, and shellcheck parses `{...}` as a literal brace group. Extracting them would produce findings about the template rather than the script, so they are deliberately not covered. Workflow `run:` blocks ARE covered, via actionlint, which substitutes GitHub expressions before handing the body over.',
  'UNTRACKED SCRIPTS. The file list is `git ls-files "*.sh"`. A script on disk that was never committed is invisible here — deliberate (the gate reports on what the repo ships) but it means a green local run can precede a red CI run on the commit that finally adds the file.',
  'SHELL WITHOUT A .sh EXTENSION. A committed script with no extension, or one invoked via `bash -c` from JavaScript, is not in the file list. Nothing currently in this repo is shaped that way, but nothing stops it from being.',
  'RUNTIME BEHAVIOUR. shellcheck is a static parser: it does not know whether a command exists, whether a path resolves, or what an external tool returns. A script can be shellcheck-clean and still be entirely wrong.',
];

const failures = [];
const fail = (headline, detail) => failures.push({ headline, detail });

/** Run shellcheck over the given files; return parsed JSON findings. */
function runShellcheck(files) {
  if (files.length === 0) return [];
  try {
    const out = execFileSync(SHELLCHECK, [`--severity=${SEVERITY}`, '--format=json', ...files], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(out || '[]');
  } catch (error) {
    // shellcheck exits non-zero when it has findings; stdout is still the JSON.
    if (error.stdout) return JSON.parse(error.stdout || '[]');
    throw error;
  }
}

function main() {
  if (!fs.existsSync(SHELLCHECK)) {
    console.error(`shellcheck gate: binary not found at ${SHELLCHECK}`);
    console.error('Run `flox activate -- task lint:shell`, which installs the pinned version first.');
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // CONTROLS FIRST — so a dead instrument reports as "the linter stopped
  // working", not as "no problems found".
  // -----------------------------------------------------------------------
  const scratch = fs.mkdtempSync(path.join(ROOT, 'node_modules/.cache/shellcheck-control-'));
  try {
    for (const control of CONTROLS) {
      const file = path.join(scratch, 'control.sh');
      fs.writeFileSync(file, control.code);
      const codes = runShellcheck([file]).map((f) => `SC${f.code}`);

      if (control.mustReport && !codes.includes(control.mustReport)) {
        fail(
          `CONTROL "${control.name}" did NOT fire`,
          `expected: ${control.mustReport}\nreported: ${codes.length ? codes.join(', ') : '(nothing at all)'}\n` +
            'A defect this gate exists to catch went unreported. A zero-finding run over the real tree means nothing until this passes.',
        );
      }
      if (control.mustBeSilent && codes.length > 0) {
        fail(
          `CONTROL "${control.name}" fired when it should not have`,
          `reported: ${codes.join(', ')}\n` +
            'The gate reports on shell that is fine, so its findings do not distinguish good scripts from bad ones.',
        );
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  // -----------------------------------------------------------------------
  // THE TREE — every tracked *.sh, zero findings permitted.
  // -----------------------------------------------------------------------
  const files = execFileSync('git', ['ls-files', '*.sh'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  if (files.length === 0) {
    fail(
      'no shell scripts found to check',
      'The file list came back empty, so a green result here would be vacuous. Either the glob broke or this is not the repo root.',
    );
  }

  const findings = runShellcheck(files);
  if (findings.length > 0) {
    const rendered = findings
      .map((f) => `  ${f.file}:${f.line}:${f.column}  SC${f.code} (${f.level})  ${f.message}`)
      .join('\n');
    fail(
      `${findings.length} shellcheck finding(s)`,
      `${rendered}\n\n` +
        'Fix them. If a finding is genuinely wrong for the site, put a `# shellcheck disable=SCxxxx # why: ...` directly above the line and say what makes it wrong — per instance, never per file.',
    );
  }

  // -----------------------------------------------------------------------
  // EVERY SUPPRESSION CARRIES ITS REASONING.
  // -----------------------------------------------------------------------
  const undocumented = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!/#\s*shellcheck\s+disable=/.test(line)) return;
      if (!/why:/i.test(line)) undocumented.push(`${file}:${index + 1}  ${line.trim()}`);
    });
  }
  if (undocumented.length > 0) {
    fail(
      `${undocumented.length} shellcheck disable directive(s) with no reason`,
      `${undocumented.map((u) => `  ${u}`).join('\n')}\n\n` +
        'A bare code records the decision and throws away the reasoning, so the next reader cannot tell a deliberate exemption from a defect someone silenced. Append `# why: ...` on the same line.',
    );
  }

  report({ files: files.length, findings: findings.length });
}

function report({ files, findings }) {
  console.log('');
  console.log('── shellcheck gate ──────────────────────────────────────────');
  console.log(`  scripts checked     ${files} (tracked *.sh)`);
  console.log(`  severity            ${SEVERITY} (strictest — style, info, warning and error all fail)`);
  console.log(`  findings            ${findings} (the permitted number is zero)`);
  console.log('');
  console.log('  THIS GATE CANNOT SEE:');
  for (const spot of BLIND_SPOTS) console.log(`    · ${wrap(spot, 4)}`);
  console.log('─────────────────────────────────────────────────────────────');

  if (failures.length === 0) {
    console.log('shellcheck gate: PASS');
    return;
  }
  console.error('');
  for (const { headline, detail } of failures) {
    console.error(`✗ ${headline}`);
    console.error(detail.replace(/^/gm, '    '));
    console.error('');
  }
  console.error(`shellcheck gate: FAIL (${failures.length} condition(s))`);
  process.exitCode = 1;
}

function wrap(text, indent) {
  const width = 74;
  const pad = ' '.repeat(indent + 2);
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out.join(`\n${pad}`);
}

main();
