// Phase 4 acceptance: two planted silences found ±100 ms; +noise variant finds
// the same regions (calibration works); music → graceful empty map.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from 'shortstop-skill/scripts/probe.mjs';
import { analyzeSilence, silenceStage } from 'shortstop-skill/scripts/silence.mjs';
import { loadConfig } from 'shortstop-skill/scripts/lib/artifacts.mjs';
import { generateFixtures, FIXTURE_DIR } from './fixtures.mjs';

const manifest = await generateFixtures();
const { config } = loadConfig('/nonexistent-no-override');
const dir = mkdtempSync(join(tmpdir(), 'shortstop-silence-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const TOL = 0.1; // ±100 ms

function assertPlantedFound(regions, planted) {
  for (const p of planted) {
    const match = regions.find((r) => Math.abs(r.start - p.start) <= TOL && Math.abs(r.end - p.end) <= TOL);
    assert.ok(match, `planted silence ${p.start.toFixed(2)}–${p.end.toFixed(2)} not found in ` +
      regions.map((r) => `${r.start.toFixed(2)}–${r.end.toFixed(2)}`).join(', '));
  }
}

test('clean speech: both planted silences detected ±100ms, calibrated', async () => {
  const art = await analyzeSilence(join(FIXTURE_DIR, 'speech.wav'), config);
  assert.equal(art.calibrated, true);
  assertPlantedFound(art.regions, manifest.speech.silences);
  // sorted + non-overlapping is enforced by schema on write; check directly here too
  for (let i = 1; i < art.regions.length; i++) {
    assert.ok(art.regions[i].start >= art.regions[i - 1].end);
  }
});

test('noisy variant: same planted silences found (calibration adapts)', async () => {
  const art = await analyzeSilence(join(FIXTURE_DIR, 'speech_noisy.wav'), config);
  assert.equal(art.calibrated, true);
  assert.ok(art.noise_floor_db > -60, `expected raised floor, got ${art.noise_floor_db}`);
  assertPlantedFound(art.regions, manifest.speech.silences);
});

test('music: graceful empty map, calibrated=false', async () => {
  const art = await analyzeSilence(join(FIXTURE_DIR, 'music.wav'), config);
  assert.equal(art.calibrated, false);
  assert.equal(art.regions.length, 0);
});

test('artifact-level stage writes schema-valid silence.json', async () => {
  const runDir = join(dir, 'run');
  await probe(join(FIXTURE_DIR, 'speech.mp4'), runDir);
  const art = await silenceStage(runDir, { config });
  assertPlantedFound(art.regions, manifest.speech.silences);
  const onDisk = JSON.parse(readFileSync(join(runDir, 'silence.json'), 'utf8'));
  assert.deepEqual(onDisk, art);
});
