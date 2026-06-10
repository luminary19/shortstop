// Phase 5 acceptance (deterministic — no LLM): canned drafts are padded/snapped
// to known silence midpoints exactly; bad drafts rejected with machine-readable reasons.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEdl } from 'shortstop-skill/scripts/build_edl.mjs';
import { loadConfig } from 'shortstop-skill/scripts/lib/artifacts.mjs';
import { snapToFrame } from 'shortstop-skill/scripts/lib/timecode.mjs';

const { config } = loadConfig('/nonexistent-no-override');

// Hand-crafted scenario, 30 fps, 12 s:
//   words: "hello"[0.2,0.7] "world"[0.8,1.4]   — keep
//   silence A: [1.6, 2.6]                      — gap silence
//   words: "um"[2.8,3.1]                       — filler to remove
//   silence B: [3.3, 4.3]
//   words: "great"[4.5,5.0] "stuff"[5.1,5.8]   — keep
//   long pause: silence C: [6.0, 9.0]
//   words: "bye"[9.2,9.6]                      — keep
const probe = {
  fps_num: 30, fps_den: 1, fps: 30, width: 1920, height: 1080, rotation: 0,
  display_width: 1920, display_height: 1080, duration_s: 12, vfr: false,
  normalized_path: null, audio_streams: [{ index: 1, codec: 'aac', sample_rate: 48000, channels: 2 }],
  audio_source: 'mix', source: '/x/raw.mp4',
};
const silence = {
  noise_floor_db: -60, threshold_db: -50, min_silence_s: 0.5, calibrated: true,
  regions: [
    { start: 1.6, end: 2.6, dur: 1.0 },
    { start: 3.3, end: 4.3, dur: 1.0 },
    { start: 6.0, end: 9.0, dur: 3.0 },
  ],
};
const W = (word, start, end, prob = 0.95) => ({ word, start, end, prob });
const transcript = {
  language: 'en', duration_s: 12,
  segments: [{
    id: 0, start: 0.2, end: 9.6, text: 'hello world um great stuff bye',
    words: [
      W('hello', 0.2, 0.7), W('world', 0.8, 1.4),
      W('um', 2.8, 3.1),
      W('great', 4.5, 5.0), W('stuff', 5.1, 5.8),
      W('bye', 9.2, 9.6),
    ],
  }],
};
const ctx = { probe, silence, transcript, config };

const draft = (keep, removed = [], notes = 'test') => ({ source: '/x/raw.mp4', keep, removed, notes });

test('filler removal: boundaries snap to flanking silence midpoints exactly', () => {
  const res = buildEdl(draft(
    [
      { start: 0.2, end: 1.4, reason: 'opening' },
      { start: 4.5, end: 5.8, reason: 'point' },
      { start: 9.2, end: 9.6, reason: 'outro' },
    ],
    [
      { start: 1.4, end: 4.5, kind: 'filler', reason: 'um' },
      { start: 5.8, end: 9.2, kind: 'pause', reason: 'long pause' },
    ],
  ), ctx);
  assert.ok(res.ok, JSON.stringify(res.reasons));
  const k = res.edl.keep;
  assert.equal(k.length, 3);
  // keep[0].end: padded 1.5, silence A [1.6,2.6]: min(mid 2.1, 1.6+0.25) = 1.85
  assert.equal(k[0].end, snapToFrame(1.85, 30, 1));
  // keep[1].start: padded 4.4, silence B [3.3,4.3]: max(mid 3.8, 4.3-0.25) = 4.05
  assert.equal(k[1].start, snapToFrame(4.05, 30, 1));
  // keep[1].end: padded 5.9, silence C [6,9]: min(mid 7.5, 6.0+0.25) = 6.25
  assert.equal(k[1].end, snapToFrame(6.25, 30, 1));
  // keep[2].start: padded 9.1, silence C: max(mid 7.5, 9.0-0.25) = 8.75
  assert.equal(k[2].start, snapToFrame(8.75, 30, 1));
  assert.ok(k[1].end <= k[2].start, `ordering violated: ${k[1].end} > ${k[2].start}`);
  // stats present and sane
  assert.ok(res.edl.stats.kept_s > 0);
  assert.ok(res.edl.stats.removed_s > 0);
});

test('pause-only removal does not collapse: padded boundaries already in silence stay', () => {
  const res = buildEdl(draft(
    [
      { start: 4.5, end: 5.8, reason: 'point' },
      { start: 9.2, end: 9.6, reason: 'outro' },
    ],
    [{ start: 5.8, end: 9.2, kind: 'pause', reason: 'dead air' }],
  ), ctx);
  assert.ok(res.ok, JSON.stringify(res.reasons));
  const k = res.edl.keep;
  assert.equal(k.length, 2, 'pause removal must survive (keeps not merged into one)');
  const removedTime = res.edl.stats.removed_s;
  assert.ok(removedTime > 2, `expected > 2s removed, got ${removedTime}`);
});

test('overlapping keeps rejected with machine-readable reason', () => {
  const res = buildEdl(draft([
    { start: 0, end: 5, reason: 'a' },
    { start: 4, end: 8, reason: 'b' },
  ]), ctx);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r) => r.code === 'schema' && /sorted and non-overlapping/.test(r.detail)));
});

test('out-of-range keep rejected', () => {
  const res = buildEdl(draft([{ start: 0.2, end: 14, reason: 'too long' }]), ctx);
  assert.equal(res.ok, false);
  assert.equal(res.reasons[0].code, 'out_of_range');
});

test('mid-word cut rejected with straddle reason naming the word', () => {
  // boundary at 4.7 lands inside "great" [4.5,5.0]; padded 4.8; the gap to the
  // next keep holds no silence, so the snap cannot rescue it → straddle.
  const res = buildEdl(draft([
    { start: 0.2, end: 4.7, reason: 'cuts into great' },
    { start: 5.1, end: 5.8, reason: 'stuff' },
    { start: 9.2, end: 9.6, reason: 'outro' },
  ]), ctx);
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r) => r.code === 'straddle' && r.detail.includes('great')), JSON.stringify(res.reasons));
});

test('sloppy word-end cut is rescued by snap into silence (no straddle)', () => {
  // cut at 5.5 inside "stuff" [5.1,5.8]: padded 5.6, then snapped right into
  // silence C (6.25) — the word ends up fully kept, by design.
  const res = buildEdl(draft([
    { start: 0.2, end: 5.5, reason: 'sloppy end' },
    { start: 9.2, end: 9.6, reason: 'outro' },
  ]), ctx);
  assert.ok(res.ok, JSON.stringify(res.reasons));
  assert.equal(res.edl.keep[0].end, snapToFrame(6.25, 30, 1));
});

test('schema-invalid draft rejected', () => {
  const res = buildEdl({ source: '/x/raw.mp4', keep: [], removed: [], notes: '' }, ctx);
  assert.equal(res.ok, false);
  assert.equal(res.reasons[0].code, 'schema');
});

test('touching keeps merge; sub-2-frame removals dropped', () => {
  const res = buildEdl(draft([
    { start: 0.2, end: 1.0, reason: 'a' },
    { start: 1.02, end: 1.4, reason: 'b' }, // 20ms gap < 2 frames @30fps
  ]), ctx);
  assert.ok(res.ok, JSON.stringify(res.reasons));
  assert.equal(res.edl.keep.length, 1);
});
