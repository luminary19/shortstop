// Phase 6 acceptance: face fixture → coverage ≥ 0.9, crop follows the known
// drift, max crop velocity bounded; no-face fixture → fallback mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from 'shortstop-skill/scripts/probe.mjs';
import { track } from 'shortstop-skill/scripts/track.mjs';
import { generateFixtures, FIXTURE_DIR } from './fixtures.mjs';

const manifest = await generateFixtures();
const dir = mkdtempSync(join(tmpdir(), 'shortstop-track-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('face fixture: tracked, drift followed, velocity bounded', { timeout: 300_000 }, async () => {
  const runDir = join(dir, 'face');
  await probe(join(FIXTURE_DIR, 'face.mp4'), runDir);
  const { artifact } = await track(runDir);

  assert.equal(artifact.mode, 'face');
  assert.ok(artifact.coverage >= 0.9, `coverage ${artifact.coverage} < 0.9`);
  assert.equal(artifact.crop_h, 1080);
  assert.equal(artifact.crop_w, 606); // even(1080*9/16=607.5)

  // ground truth: face image (square) scaled to height H, center x = x0 + speed*t + H/2
  const { x0, speed, faceHeight } = manifest.face_motion;
  const cxTrue = (t) => x0 + speed * t + faceHeight / 2;

  // detections must follow the drift tightly
  for (const d of artifact.detections) {
    assert.ok(Math.abs(d.cx - cxTrue(d.t)) < 120,
      `detection at t=${d.t}: cx=${d.cx}, expected ~${cxTrue(d.t).toFixed(0)}`);
  }

  // smoothed crop window must contain the face center with margin at every keyframe
  // (dead-zone means it lags the target, so assert containment, not equality)
  for (const p of artifact.crop_path) {
    const cx = cxTrue(p.t);
    assert.ok(cx > p.x + 60 && cx < p.x + artifact.crop_w - 60,
      `t=${p.t}: face center ${cx.toFixed(0)} outside crop [${p.x}, ${p.x + artifact.crop_w}]`);
  }

  // bounded crop velocity (smoothing works) — asserted numerically
  let maxVel = 0;
  for (let i = 1; i < artifact.crop_path.length; i++) {
    const a = artifact.crop_path[i - 1];
    const b = artifact.crop_path[i];
    const dt = b.t - a.t;
    if (dt > 0) maxVel = Math.max(maxVel, Math.abs(b.x - a.x) / dt);
  }
  assert.ok(maxVel <= 260, `max crop velocity ${maxVel.toFixed(0)} px/s exceeds bound`);

  // even-pixel alignment
  for (const p of artifact.crop_path) {
    assert.equal(p.x % 2, 0);
    assert.equal(p.y % 2, 0);
  }
});

test('no-face fixture (testsrc2): fallback mode', { timeout: 300_000 }, async () => {
  const runDir = join(dir, 'noface');
  await probe(join(FIXTURE_DIR, 'speech.mp4'), runDir);
  const { artifact } = await track(runDir);
  assert.equal(artifact.mode, 'fallback');
  assert.ok(artifact.coverage < 0.5);
  assert.equal(artifact.crop_path.length, 1);
});
