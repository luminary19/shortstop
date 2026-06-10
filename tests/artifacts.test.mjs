// Phase 0 acceptance: valid samples of all six artifacts round-trip through
// artifacts.mjs; malformed samples are rejected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARTIFACT_KINDS, readArtifact, writeArtifact, validateArtifact, ArtifactError, loadConfig,
} from 'shortstop-skill/scripts/lib/artifacts.mjs';

const VALID = {
  probe: {
    fps_num: 30000, fps_den: 1001, fps: 29.97002997,
    width: 1920, height: 1080, rotation: 0,
    display_width: 1920, display_height: 1080,
    duration_s: 12.5, vfr: false, normalized_path: null,
    audio_streams: [{ index: 1, codec: 'aac', sample_rate: 48000, channels: 2 }],
    audio_source: 'mix',
    source: 'input/raw.mp4',
  },
  transcript: {
    language: 'en', duration_s: 12.5,
    segments: [{
      id: 0, start: 0.1, end: 2.4, text: 'Hello everyone.',
      words: [
        { word: 'Hello', start: 0.1, end: 0.6, prob: 0.99 },
        { word: 'everyone.', start: 0.7, end: 1.4, prob: 0.97 },
      ],
    }],
  },
  silence: {
    noise_floor_db: -62.5, threshold_db: -50, min_silence_s: 0.5, calibrated: true,
    regions: [
      { start: 2.85, end: 4.05, dur: 1.2 },
      { start: 8.7, end: 10.2, dur: 1.5 },
    ],
  },
  track: {
    mode: 'face', sample_fps: 5,
    detections: [{ t: 0, cx: 960, cy: 400, w: 220, h: 280, conf: 0.93 }],
    crop_path: [{ t: 0, x: 656, y: 0 }, { t: 0.2, x: 658, y: 0 }],
    crop_w: 608, crop_h: 1080, coverage: 0.96,
  },
  edl: {
    source: 'input/raw.mp4',
    keep: [
      { start: 0, end: 2.9, reason: 'intro line' },
      { start: 5.1, end: 8.8, reason: 'main point, clean retake' },
    ],
    removed: [
      { start: 2.9, end: 5.1, kind: 'false_start', reason: 'abandoned first attempt' },
    ],
    notes: 'kept the second take',
  },
  qa_report: {
    verdict: 'gap', attempt: 0, score: 72.5,
    signals: { duration_s: 6.6, lufs: -16.4, true_peak_db: -1.3 },
    gaps: [{
      signal: 'loudness', severity: 'hard', observed: -16.4, target: -14,
      suggested_fix: 'recompute loudnorm with measured values',
    }],
  },
  ideas: {
    source: 'input/raw.mp4',
    ideas: [
      { id: 1, title: 'The core trick', start: 4.5, end: 61.0, strength: 4, summary: 'setup and payoff of the trick' },
      { id: 2, title: 'Why it scales', start: 70.2, end: 118.7, strength: 3 },
    ],
    notes: 'two clean ideas; intro housekeeping skipped',
  },
};

// One representative corruption per kind.
const MALFORMED = {
  probe: { ...VALID.probe, fps_num: 0 },
  transcript: {
    ...VALID.transcript,
    segments: [{ id: 0, start: 0, end: 1, text: 'no words key' }],
  },
  silence: {
    ...VALID.silence,
    regions: [
      { start: 5, end: 6, dur: 1 },
      { start: 4, end: 7, dur: 3 }, // out of order + overlapping
    ],
  },
  track: { ...VALID.track, mode: 'tripod' },
  edl: {
    ...VALID.edl,
    keep: [
      { start: 0, end: 5, reason: 'a' },
      { start: 4, end: 8, reason: 'overlaps previous' },
    ],
  },
  qa_report: { ...VALID.qa_report, verdict: 'maybe' },
  ideas: {
    ...VALID.ideas,
    ideas: [
      { id: 1, title: 'a', start: 0, end: 30, strength: 4 },
      { id: 2, title: 'b', start: 25, end: 60, strength: 3 }, // overlaps previous
    ],
  },
};

const dir = mkdtempSync(join(tmpdir(), 'shortstop-artifacts-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

for (const kind of ARTIFACT_KINDS) {
  test(`${kind}: valid sample round-trips`, () => {
    const path = join(dir, `${kind}.json`);
    writeArtifact(kind, path, VALID[kind]);
    const back = readArtifact(kind, path);
    assert.deepEqual(back, VALID[kind]);
  });

  test(`${kind}: malformed sample is rejected`, () => {
    assert.throws(
      () => validateArtifact(kind, MALFORMED[kind]),
      (err) => err instanceof ArtifactError && err.kind === kind,
    );
    assert.throws(() => writeArtifact(kind, join(dir, `${kind}-bad.json`), MALFORMED[kind]));
  });
}

test('unknown artifact kind is rejected', () => {
  assert.throws(() => validateArtifact('bogus', {}), /unknown artifact kind/);
});

test('default config loads and validates (shorts preset)', () => {
  const { config, overridden } = loadConfig(dir);
  assert.equal(overridden, false);
  assert.equal(config.mode, 'shorts');
  assert.equal(config.aspect.mode, '9:16');
  assert.equal(config.aspect.out_width, 720);
  assert.equal(config.aspect.out_height, 1280);
  assert.equal(config.cut.max_clip_s, 60);
  assert.equal(config.qa.shorts_max_s, 60);
  assert.equal(config.qa.max_fix_attempts, 5);
});

test('longform mode preset flips aspect and lifts caps', async () => {
  const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const lf = join(dir, 'longform-proj');
  mkdirSync(lf, { recursive: true });
  writeFileSync(join(lf, 'shortstop.config.json'), JSON.stringify({ mode: 'longform' }));
  const { config } = loadConfig(lf);
  assert.equal(config.mode, 'longform');
  assert.equal(config.aspect.mode, '16:9');
  assert.equal(config.aspect.out_width, 1920);
  assert.equal(config.aspect.out_height, 1080);
  assert.equal(config.cut.max_clip_s, null);
  assert.equal(config.qa.shorts_max_s, null);
  rmSync(lf, { recursive: true, force: true });
});

test('run-level config.overrides.json wins over project config', async () => {
  const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const proj = join(dir, 'run-override-proj');
  const runDir = join(proj, 'runs', 'r1');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(proj, 'shortstop.config.json'), JSON.stringify({ mode: 'shorts', render: { crf: 20 } }));
  writeFileSync(join(runDir, 'config.overrides.json'), JSON.stringify({ mode: 'longform' }));
  const { config, overridden } = loadConfig(proj, { runDir });
  assert.equal(overridden, true);
  assert.equal(config.mode, 'longform');
  assert.equal(config.aspect.out_width, 1920);
  assert.equal(config.render.crf, 20); // project tweak survives the run-level mode flip
  rmSync(proj, { recursive: true, force: true });
});

test('explicit aspect override beats the mode preset', async () => {
  const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const proj = join(dir, 'aspect-override-proj');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'shortstop.config.json'),
    JSON.stringify({ mode: 'shorts', aspect: { out_width: 1080, out_height: 1920 } }));
  const { config } = loadConfig(proj);
  assert.equal(config.aspect.out_width, 1080);
  assert.equal(config.aspect.out_height, 1920);
  rmSync(proj, { recursive: true, force: true });
});

test('project override merges over defaults', async () => {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'shortstop.config.json'),
    JSON.stringify({ captions: { enabled: false }, render: { crf: 20 } }));
  const { config, overridden } = loadConfig(dir);
  assert.equal(overridden, true);
  assert.equal(config.captions.enabled, false);
  assert.equal(config.render.crf, 20);
  assert.equal(config.captions.size, 96); // untouched default survives
});

test('invalid project override is rejected', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const bad = join(dir, 'badcfg');
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, 'shortstop.config.json'), JSON.stringify({ render: { crf: 99 } }));
  assert.throws(() => loadConfig(bad), ArtifactError);
});
