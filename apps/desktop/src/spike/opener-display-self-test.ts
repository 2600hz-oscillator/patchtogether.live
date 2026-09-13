// Runs the actual Electron harness against the built /present sink. Failure
// controls must fail; predicate-only tests cannot establish that the instrument
// samples the real subject. This is a local task, not a new required CI gate.
import electron from 'electron';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import type { StepResult } from './opener-display-logic';

const repeat = Number(process.env.REPEAT ?? 1);
assert.ok(Number.isInteger(repeat) && repeat >= 1 && repeat <= 10, 'REPEAT must be 1..10');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-spike-self-test-'));
const cases = [
  { name: 'healthy', code: 0 },
  { name: 'hidden', code: 1, step: 'composited' },
  { name: 'frozen-composite', code: 1, step: 'composited' },
  { name: 'blank-after-first', code: 1, step: 'blitPixels' },
  { name: 'frozen', code: 1, step: 'motion' },
  { name: 'no-pulls', code: 1 },
  { name: 'write-result', code: 1 },
  { name: 'real-fault-refused', code: 1 },
] as const;

async function launch(name: string, dir: string): Promise<{ code: number | null; log: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, PT_SPIKE_RESULTS_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PT_SPIKE_DRY_RUN;
  delete env.PT_SPIKE_CRASH_PROBE;
  delete env.PT_SPIKE_TEST_FAULT;
  const real = name === 'real-fault-refused';
  if (['hidden', 'blank-after-first', 'frozen', 'no-pulls', 'frozen-composite'].includes(name) || real) {
    env.PT_SPIKE_TEST_FAULT = real ? 'hidden' : name;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(electron as unknown as string,
      [path.join(__dirname, 'opener-display-spike.js'), ...(real ? [] : ['--dry-run'])],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (data: Buffer) => { log += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { log += data.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 170_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, log }); });
  });
}

async function run(): Promise<void> {
  console.log('Self-test records:', output);
  for (let round = 1; round <= repeat; round++) {
    for (const c of cases) {
      const dir = path.join(output, `${round}-${c.name}`);
      if (c.name === 'write-result') fs.writeFileSync(dir, 'file blocks the result directory');
      const result = await launch(c.name, dir);
      fs.writeFileSync(dir + '.log', result.log);
      assert.equal(result.code, c.code, `${c.name}: expected exit ${c.code}; ${result.log}`);
      if (c.name === 'write-result') {
        assert.match(result.log, /RESULT WRITE FAILED/);
        assert.doesNotMatch(result.log, /DRY-RUN OK/);
      } else {
        const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
        assert.equal(files.length, 1, c.name);
        const record = JSON.parse(fs.readFileSync(path.join(dir, files[0]!), 'utf8')) as {
          exitCode: number; steps: StepResult[]; verdictLines: string[]; observations: { frames?: { geometryResets: number } };
        };
        assert.equal(record.exitCode, c.code);
        if ('step' in c) {
          const failed = record.steps.find((s) => s.status === 'FAIL');
          // Freezing the canvas before an OS fullscreen resize leaves its new
          // backing store blank. That is a valid pixel failure, not a flaky motion assertion.
          if (c.name === 'frozen' && failed?.id === 'blitPixels') {
            assert.ok((record.observations.frames?.geometryResets ?? 0) > 0, c.name);
          } else assert.equal(failed?.id, c.step, c.name);
        }
        if (c.name === 'healthy') {
          for (const id of ['domAccess', 'blitPixels', 'motion', 'composited']) {
            assert.equal(record.steps.find((s) => s.id === id)?.status, 'PASS', id);
          }
          assert.equal(record.steps.find((s) => s.id === 'operator')?.status, 'DRY');
        }
        if (c.name === 'no-pulls') assert.match(record.verdictLines.join('\n'), /samples=0/);
        if (c.name === 'real-fault-refused') assert.match(record.verdictLines.join('\n'), /faults require --dry-run/);
        if (c.code) assert.ok(record.verdictLines.every((line) => !/DRY-RUN OK|SPIKE PASS/.test(line)), c.name);
      }
      console.log(`PASS ${round}/${repeat} ${c.name} (expected exit ${c.code})`);
    }
  }
}
run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
