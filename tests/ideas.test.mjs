// Idea segmentation guardrail + multi-clip delivery naming (deterministic — no LLM).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateIdeas, prepareClipDirs } from 'shortstop-skill/scripts/segment_ideas.mjs';
import { deliver } from 'shortstop-skill/scripts/deliver.mjs';
import { writeArtifact, loadConfig } from 'shortstop-skill/scripts/lib/artifacts.mjs';

const { config } = loadConfig('/nonexistent-no-override'); // shorts preset: max_clip_s 60

const dir = mkdtempSync(join(tmpdir(), 'shortstop-ideas-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const probe = {
  fps_num: 30, fps_den: 1, fps: 30, width: 1920, height: 1080, rotation: 0,
  display_width: 1920, display_height: 1080, duration_s: 300, vfr: false,
  normalized_path: null, audio_streams: [{ index: 1, codec: 'aac', sample_rate: 48000, channels: 2 }],
  audio_source: 'mix', source: '/x/myvid.mp4',
};

const draft = (ideas) => ({ source: '/x/myvid.mp4', ideas, notes: 'test' });

test('valid idea list passes', () => {
  const res = validateIdeas(draft([
    { id: 1, title: 'first idea', start: 10, end: 75, strength: 4 },
    { id: 2, title: 'second idea', start: 90, end: 160, strength: 3 },
  ]), { probe, config });
  assert.ok(res.ok, JSON.stringify(res.reasons));
});

test('idea beyond source duration rejected as out_of_range', () => {
  const res = validateIdeas(draft([
    { id: 1, title: 'overruns', start: 250, end: 320, strength: 3 },
  ]), { probe, config });
  assert.equal(res.ok, false);
  assert.equal(res.reasons[0].code, 'out_of_range');
});

test('idea raw span under 5s rejected as too_short', () => {
  const res = validateIdeas(draft([
    { id: 1, title: 'sliver', start: 10, end: 13, strength: 3 },
  ]), { probe, config });
  assert.equal(res.ok, false);
  assert.equal(res.reasons[0].code, 'too_short');
});

test('idea raw span over 2x max_clip_s rejected as too_long', () => {
  const res = validateIdeas(draft([
    { id: 1, title: 'sprawl', start: 10, end: 140, strength: 3 }, // 130s > 120s
  ]), { probe, config });
  assert.equal(res.ok, false);
  assert.equal(res.reasons[0].code, 'too_long');
});

test('overlapping ideas rejected at schema level', () => {
  const res = validateIdeas(draft([
    { id: 1, title: 'a', start: 10, end: 75, strength: 4 },
    { id: 2, title: 'b', start: 70, end: 130, strength: 3 },
  ]), { probe, config });
  assert.equal(res.ok, false);
  assert.equal(res.reasons[0].code, 'schema');
});

test('prepareClipDirs creates one workspace per idea with shared artifacts copied', () => {
  const runDir = join(dir, 'prep-run');
  mkdirSync(runDir, { recursive: true });
  writeArtifact('probe', join(runDir, 'probe.json'), probe);
  writeFileSync(join(runDir, 'config.overrides.json'), JSON.stringify({ mode: 'shorts' }));
  const ideas = draft([
    { id: 1, title: 'a', start: 10, end: 75, strength: 4 },
    { id: 3, title: 'c', start: 90, end: 160, strength: 3 },
  ]);
  writeArtifact('ideas', join(runDir, 'ideas.json'), ideas);
  const dirs = prepareClipDirs(runDir, ideas);
  assert.deepEqual(dirs, [join(runDir, 'clip1'), join(runDir, 'clip3')]);
  for (const d of dirs) {
    assert.ok(existsSync(join(d, 'probe.json')));
    assert.ok(existsSync(join(d, 'config.overrides.json')));
    assert.ok(existsSync(join(d, 'ideas.json')));
    assert.ok(!existsSync(join(d, 'transcript.json'))); // absent shared files are skipped
  }
});

test('deliver from a clip subdir names output <stem>-<runid>-clipN.mp4 and spares sibling runs', () => {
  const runsRoot = join(dir, 'runs');
  const runId = '20260101-000000-abcd';
  const clipDir = join(runsRoot, runId, 'clip2');
  const sibling = join(runsRoot, '20260101-000001-zzzz');
  mkdirSync(clipDir, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  writeArtifact('probe', join(clipDir, 'probe.json'), probe);
  writeArtifact('qa_report', join(clipDir, 'qa_report_a0.json'), {
    verdict: 'pass', attempt: 0, score: 100, signals: {}, gaps: [],
  });
  writeFileSync(join(clipDir, 'candidate_a0.mp4'), 'fake-mp4-bytes');

  const outputDir = join(dir, 'output');
  const res = deliver(clipDir, outputDir, { attempt: 0, config });
  assert.equal(res.decision, 'deliver');
  assert.equal(res.deliveredPath, join(outputDir, `myvid-${runId}-clip2.mp4`));
  assert.ok(existsSync(res.deliveredPath));
  // pruning targeted the runs root (keep_last=10 keeps both), never the clip dirs inside the run
  assert.ok(existsSync(sibling));
  assert.ok(existsSync(clipDir));
});
