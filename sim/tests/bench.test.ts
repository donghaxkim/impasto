/** Smoke test for `npm run bench` (tests/bench.ts): a plan-only run on a tiny synthetic image, a few seconds. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthetic } from './bench.ts';
import { DEFAULT_SETTINGS, planPainting } from '../src/planner.ts';

const BENCH = fileURLToPath(new URL('./bench.ts', import.meta.url));

test('bench: --quick --plan-only writes a report, and its planning loop matches planPainting', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bench-smoke-'));
  try {
    const json = path.join(dir, 'smoke.json');
    execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', BENCH, '--quick', '--scenes', 'synthetic', '--width', '40', '--plan-only', '--json', json], { stdio: 'pipe' });
    const r = JSON.parse(readFileSync(json, 'utf8'));
    assert.equal(r.kind, 'impasto-bench');
    assert.ok(r.machine.cpu && r.machine.cores > 0 && r.machine.node);
    assert.equal(r.runs.length, 1);
    assert.ok(r.runs[0].ok, r.runs[0].error);
    const g = r.results[0];
    assert.equal(g.scene, 'synthetic');
    assert.equal(g.formsCheck, 'matches planner');
    for (const s of ['load', 'setup', 'resample', 'analysis', 'forms', 'planning', 'total']) assert.ok(g.ms[s].median >= 0, s);
    assert.equal(g.ms.painting, undefined);
    assert.ok(g.strokes > 0 && g.canvasMcells > 0 && g.gridMcells > 0 && g.peakRssMb > 0);
    assert.ok(existsSync(path.join(dir, 'smoke.md')) && existsSync(path.join(dir, 'summary.md')));
    // The bench drives Planner layer by layer itself (to time painting apart); it must plan the same.
    const plan = planPainting(synthetic(), { ...DEFAULT_SETTINGS, widthMm: 40, look: 'oil' });
    assert.equal(g.planHash, createHash('sha256').update(JSON.stringify(plan.strokes)).digest('hex').slice(0, 16));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
