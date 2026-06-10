// Phase 7 acceptance: Dialogue times within output duration, grouping rules
// hold, and ffmpeg parses the .ass (dry-run burn on black).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAss, mapWordsToOutput, groupLines } from 'shortstop-skill/scripts/build_captions.mjs';
import { loadConfig, SKILL_ROOT } from 'shortstop-skill/scripts/lib/artifacts.mjs';
import { ffmpeg, escapeFilterPath } from 'shortstop-skill/scripts/lib/ffmpeg.mjs';

const { config } = loadConfig('/nonexistent-no-override');
const dir = mkdtempSync(join(tmpdir(), 'shortstop-captions-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const probe = {
  fps_num: 30, fps_den: 1, fps: 30, width: 1920, height: 1080, rotation: 0,
  display_width: 1920, display_height: 1080, duration_s: 12, vfr: false,
  normalized_path: null, audio_streams: [{ index: 1, codec: 'aac', sample_rate: 48000, channels: 2 }],
  audio_source: 'mix', source: '/x/raw.mp4',
};
const W = (word, start, end) => ({ word, start, end, prob: 0.95 });
const transcript = {
  language: 'en', duration_s: 12,
  segments: [{
    id: 0, start: 0.2, end: 9.6, text: '',
    words: [
      W('One', 0.2, 0.5), W('two', 0.6, 0.9), W('three', 1.0, 1.3), W('four', 1.4, 1.7),
      W('five', 1.8, 2.1), W('ends.', 2.2, 2.5),
      // removed gap 2.6–5.0
      W('Second', 5.0, 5.4), W('segment', 5.5, 5.9), W('words', 6.0, 6.4),
    ],
  }],
};
// 2-keep EDL: [0, 2.6] + [5.0, 6.5] → output duration 4.1 s
const edl = {
  source: '/x/raw.mp4',
  keep: [
    { start: 0, end: 2.6, reason: 'a' },
    { start: 5.0, end: 6.5, reason: 'b' },
  ],
  removed: [{ start: 2.6, end: 5.0, kind: 'pause', reason: 'gap' }],
  notes: '',
};

test('word mapping: output times contiguous across the cut', () => {
  const { words, outputDuration } = mapWordsToOutput(transcript, edl, probe);
  assert.equal(words.length, 9);
  assert.ok(Math.abs(outputDuration - 4.1) < 1e-6);
  const second = words.find((w) => w.word === 'Second');
  assert.ok(Math.abs(second.start - 2.6) < 1e-2, `Second at ${second.start}, expected ~2.6`);
  for (const w of words) assert.ok(w.end <= outputDuration + 1e-6);
});

test('line grouping: max words, max seconds, punctuation, cut junction', () => {
  const { words } = mapWordsToOutput(transcript, edl, probe);
  const lines = groupLines(words, config.captions);
  for (const line of lines) {
    assert.ok(line.length <= config.captions.max_words_per_line);
    assert.ok(line[line.length - 1].end - line[0].start <= config.captions.max_line_s + 0.5,
      'line too long in seconds');
    assert.equal(new Set(line.map((w) => w.keep)).size, 1, 'line crosses a cut junction');
  }
  // sentence punctuation breaks: "ends." terminates its line
  const punctLine = lines.find((l) => l.some((w) => w.word === 'ends.'));
  assert.equal(punctLine[punctLine.length - 1].word, 'ends.');
});

test('ASS builds, events in range, ffmpeg parses and burns it', { timeout: 120_000 }, async () => {
  const { ass, outputDuration, lineCount } = buildAss(transcript, edl, probe, config);
  assert.ok(lineCount > 0);
  const eventLines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(eventLines.length, lineCount);
  assert.ok(ass.includes('\\k'), 'karaoke tags expected');

  const assPath = join(dir, 'captions.ass');
  writeFileSync(assPath, ass);
  const fontsDir = join(SKILL_ROOT, 'assets', 'fonts');
  // dry-run burn on 1 s of black at output size — fails loudly on a bad .ass
  await ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=black:size=1080x1920:rate=30:duration=1',
    '-vf', `subtitles=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(fontsDir)}`,
    '-frames:v', '10', '-f', 'null', '-',
  ]);
});
