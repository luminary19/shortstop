// Phase 3 acceptance: speech fixture → schema-valid transcript, word timestamps
// in [0, duration], planted words present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from 'shortstop-skill/scripts/probe.mjs';
import { transcribe } from 'shortstop-skill/scripts/transcribe.mjs';
import { generateFixtures, FIXTURE_DIR } from './fixtures.mjs';

await generateFixtures();
const dir = mkdtempSync(join(tmpdir(), 'shortstop-transcribe-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('speech fixture transcribes with word-level timestamps', { timeout: 600_000 }, async () => {
  const runDir = join(dir, 'run');
  const { artifact: probeArt } = await probe(join(FIXTURE_DIR, 'speech.mp4'), runDir);
  const { transcript } = await transcribe(runDir); // readArtifact inside = schema-valid

  assert.ok(transcript.segments.length >= 1, 'expected at least one segment');
  const words = transcript.segments.flatMap((s) => s.words);
  assert.ok(words.length >= 10, `expected >= 10 words, got ${words.length}`);

  for (const w of words) {
    assert.ok(w.start >= 0 && w.end <= probeArt.duration_s + 0.01,
      `word "${w.word}" [${w.start},${w.end}] outside [0,${probeArt.duration_s}]`);
    assert.ok(w.end >= w.start);
  }

  const fullText = transcript.segments.map((s) => s.text).join(' ').toLowerCase();
  for (const planted of ['hello', 'welcome', 'today', 'special', 'started']) {
    assert.ok(fullText.includes(planted), `planted word "${planted}" missing from: ${fullText}`);
  }
});
