// Phase 8 acceptance: 2-segment EDL → playable mp4 at 1080×1920, fps == source
// rational, duration == Σkeep ± 1 frame, −14 ± 1 LUFS, ≤ −1 dBTP, source rate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from 'shortstop-skill/scripts/probe.mjs';
import { track } from 'shortstop-skill/scripts/track.mjs';
import { captionsStage } from 'shortstop-skill/scripts/build_captions.mjs';
import { renderStage, totalKeepS } from 'shortstop-skill/scripts/render.mjs';
import { writeArtifact, loadConfig } from 'shortstop-skill/scripts/lib/artifacts.mjs';
import { ffmpegInfo, ffprobeJson } from 'shortstop-skill/scripts/lib/ffmpeg.mjs';
import { generateFixtures, FIXTURE_DIR } from './fixtures.mjs';

await generateFixtures();
const { config } = loadConfig('/nonexistent-no-override');
const dir = mkdtempSync(join(tmpdir(), 'shortstop-render-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function fakeTranscript(duration) {
  return {
    language: 'en', duration_s: duration,
    segments: [{
      id: 0, start: 0.5, end: 8.0, text: 'caption words here',
      words: [
        { word: 'caption', start: 0.6, end: 1.0, prob: 0.9 },
        { word: 'words', start: 1.1, end: 1.5, prob: 0.9 },
        { word: 'here', start: 4.4, end: 4.8, prob: 0.9 },
      ],
    }],
  };
}

async function measure(path) {
  const res = await ffmpegInfo(['-loglevel', 'info', '-i', path,
    '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-']);
  const text = res.all ?? res.stderr;
  return JSON.parse(text.slice(text.lastIndexOf('{'), text.lastIndexOf('}') + 1));
}

test('blur-pad render path (no face): full acceptance gates', { timeout: 600_000 }, async () => {
  const runDir = join(dir, 'speech');
  const { artifact: p } = await probe(join(FIXTURE_DIR, 'speech.mp4'), runDir);
  await track(runDir); // testsrc2 → fallback mode
  const edl = {
    source: p.source,
    keep: [
      { start: 0.5, end: 2.8, reason: 'first' },
      { start: 4.1, end: 8.7, reason: 'second' },
    ],
    removed: [{ start: 2.8, end: 4.1, kind: 'pause', reason: 'gap' }],
    notes: 'test edl',
  };
  writeArtifact('edl', join(runDir, 'edl.json'), edl);
  writeArtifact('transcript', join(runDir, 'transcript.json'), fakeTranscript(p.duration_s));
  captionsStage(runDir, { config });

  const { candidate } = await renderStage(runDir, { attempt: 0, config });

  const data = await ffprobeJson(['-show_streams', '-show_format', candidate]);
  const v = data.streams.find((s) => s.codec_type === 'video');
  const a = data.streams.find((s) => s.codec_type === 'audio');
  assert.equal(v.width, 1080);
  assert.equal(v.height, 1920);
  assert.equal(v.r_frame_rate, '30/1');
  assert.equal(Number(a.sample_rate), 48000);
  const dur = Number(data.format.duration);
  const expected = totalKeepS(edl);
  assert.ok(Math.abs(dur - expected) <= 2 / 30 + 0.05, `duration ${dur} vs Σkeep ${expected}`);

  const loud = await measure(candidate);
  assert.ok(Math.abs(Number(loud.input_i) - (-14)) <= 1, `integrated ${loud.input_i} LUFS not within -14±1`);
  assert.ok(Number(loud.input_tp) <= -1 + 0.1, `true peak ${loud.input_tp} > -1 dBTP`);
});

test('face render path: sendcmd dynamic crop + pass-B-only rerender', { timeout: 600_000 }, async () => {
  const runDir = join(dir, 'face');
  const { artifact: p } = await probe(join(FIXTURE_DIR, 'face.mp4'), runDir);
  const { artifact: t } = await track(runDir);
  assert.equal(t.mode, 'face');
  const edl = {
    source: p.source,
    keep: [
      { start: 0.5, end: 4.0, reason: 'a' },
      { start: 6.0, end: 9.5, reason: 'b' },
    ],
    removed: [{ start: 4.0, end: 6.0, kind: 'pause', reason: 'gap' }],
    notes: '',
  };
  writeArtifact('edl', join(runDir, 'edl.json'), edl);
  writeArtifact('transcript', join(runDir, 'transcript.json'), fakeTranscript(p.duration_s));
  captionsStage(runDir, { config });

  const first = await renderStage(runDir, { attempt: 0, config });
  assert.equal(first.passARan, true);
  const v = (await ffprobeJson(['-show_streams', first.candidate])).streams.find((s) => s.codec_type === 'video');
  assert.equal(v.width, 1080);
  assert.equal(v.height, 1920);

  // unchanged EDL → pass B only
  const second = await renderStage(runDir, { attempt: 1, config });
  assert.equal(second.passARan, false);
  assert.ok(second.candidate.endsWith('candidate_a1.mp4'));
});
