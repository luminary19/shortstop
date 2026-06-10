// Phase 2 acceptance: NTSC exact rational, VFR normalized, rotation corrected,
// 21-min rejected, clean input fast-path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from 'shortstop-skill/scripts/probe.mjs';
import { readArtifact } from 'shortstop-skill/scripts/lib/artifacts.mjs';
import { generateFixtures, FIXTURE_DIR } from './fixtures.mjs';

await generateFixtures();
const dir = mkdtempSync(join(tmpdir(), 'shortstop-probe-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const fx = (name) => join(FIXTURE_DIR, name);

test('NTSC fixture: exact 30000/1001 rational fps', async () => {
  const { artifact } = await probe(fx('ntsc.mp4'), join(dir, 'ntsc'));
  assert.equal(artifact.fps_num, 30000);
  assert.equal(artifact.fps_den, 1001);
  assert.equal(artifact.vfr, false);
  assert.equal(artifact.normalized_path, null);
});

test('VFR fixture: detected and normalized to CFR', async () => {
  const { artifact } = await probe(fx('vfr.mp4'), join(dir, 'vfr'));
  assert.equal(artifact.vfr, true);
  assert.ok(artifact.normalized_path, 'normalized intermediate expected');
  assert.ok(existsSync(artifact.normalized_path));
  // fps of the normalized file is a standard rate and CFR by construction
  const { artifact: re } = await probe(artifact.normalized_path, join(dir, 'vfr-re'));
  assert.equal(re.vfr, false);
});

test('rotated fixture: display dims corrected, rotation baked', async () => {
  const { artifact } = await probe(fx('rotated.mp4'), join(dir, 'rot'));
  assert.notEqual(artifact.rotation, 0);
  assert.equal(artifact.display_width, 1080);
  assert.equal(artifact.display_height, 1920);
  assert.ok(artifact.normalized_path);
  // normalized file has the rotation baked into real pixel dims
  assert.equal(artifact.width, 1080);
  assert.equal(artifact.height, 1920);
});

test('over-cap input: rejected with one-line message', async () => {
  // default cap is 60 min; tighten it to exercise the rejection on the 21-min fixture
  const { loadConfig } = await import('shortstop-skill/scripts/lib/artifacts.mjs');
  const config = loadConfig('/nonexistent-no-override').config;
  config.input.max_minutes = 20;
  const res = await probe(fx('long21.mp4'), join(dir, 'long'), { config });
  assert.ok(res.rejected);
  assert.match(res.rejected, /over the 20 min limit/);
  assert.ok(!res.rejected.includes('\n'));
  assert.ok(!existsSync(join(dir, 'long', 'probe.json')));
});

test('clean speech fixture: fast path, artifact validates and round-trips', async () => {
  const { artifact } = await probe(fx('speech.mp4'), join(dir, 'speech'));
  assert.equal(artifact.vfr, false);
  assert.equal(artifact.normalized_path, null);
  assert.equal(artifact.fps_num, 30);
  assert.equal(artifact.fps_den, 1);
  assert.equal(artifact.audio_streams.length, 1);
  assert.equal(artifact.audio_source, 'mix');
  const back = readArtifact('probe', join(dir, 'speech', 'probe.json'));
  assert.deepEqual(back, artifact);
});
