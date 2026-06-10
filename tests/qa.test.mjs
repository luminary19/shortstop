// Phase 9 acceptance: (a) empty reference/ aborts with the add-a-reference
// message; (b) forced black frames → hard gap → refuse path writes QA_REPORT.md
// and no mp4; (c) non-converging soft gap terminates ≤ 5 via no-progress guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from 'shortstop-skill/scripts/probe.mjs';
import { track } from 'shortstop-skill/scripts/track.mjs';
import { captionsStage } from 'shortstop-skill/scripts/build_captions.mjs';
import { renderStage } from 'shortstop-skill/scripts/render.mjs';
import { qaMeasure, ensureReference, referenceSignals } from 'shortstop-skill/scripts/qa.mjs';
import { deliver, pruneRuns } from 'shortstop-skill/scripts/deliver.mjs';
import { runQaLoop, deliveryDecision } from 'shortstop-skill/scripts/lib/qaloop.mjs';
import { writeArtifact, loadConfig } from 'shortstop-skill/scripts/lib/artifacts.mjs';
import { ffmpeg } from 'shortstop-skill/scripts/lib/ffmpeg.mjs';
import { generateFixtures, FIXTURE_DIR } from './fixtures.mjs';

await generateFixtures();
const { config } = loadConfig('/nonexistent-no-override');
const base = mkdtempSync(join(tmpdir(), 'shortstop-qa-'));
test.after(() => rmSync(base, { recursive: true, force: true }));

const referenceDir = join(base, 'reference');
mkdirSync(referenceDir);
copyFileSync(join(FIXTURE_DIR, 'reference.mp4'), join(referenceDir, 'style.mp4'));

const runsRoot = join(base, 'runs');
const runDir = join(runsRoot, '20260610-120000-test');
const outputDir = join(base, 'output');

test('(a) empty reference/ aborts with actionable message', () => {
  const empty = join(base, 'empty-ref');
  mkdirSync(empty);
  assert.throws(() => ensureReference(empty), /Add one finished Short you like/);
  assert.ok(ensureReference(referenceDir).endsWith('style.mp4'));
});

test('reference signals computed once and cached', { timeout: 300_000 }, async () => {
  const s1 = await referenceSignals(join(referenceDir, 'style.mp4'));
  assert.ok(s1.duration_s > 0);
  assert.ok(existsSync(join(referenceDir, '.shortstop-cache')));
  const s2 = await referenceSignals(join(referenceDir, 'style.mp4'));
  assert.deepEqual(s1, s2);
});

// shared pipeline state for the remaining tests (rendered once)
async function setupRun() {
  const { artifact: p } = await probe(join(FIXTURE_DIR, 'speech.mp4'), runDir);
  await track(runDir);
  writeArtifact('edl', join(runDir, 'edl.json'), {
    source: p.source,
    keep: [
      { start: 0.5, end: 2.8, reason: 'first' },
      { start: 4.1, end: 8.7, reason: 'second' },
    ],
    removed: [{ start: 2.8, end: 4.1, kind: 'pause', reason: 'gap' }],
    notes: '',
  });
  writeArtifact('transcript', join(runDir, 'transcript.json'), {
    language: 'en', duration_s: p.duration_s,
    segments: [{
      id: 0, start: 0.6, end: 8.0, text: 'caption words here',
      words: [
        { word: 'caption', start: 0.6, end: 1.0, prob: 0.9 },
        { word: 'words', start: 1.1, end: 1.5, prob: 0.9 },
        { word: 'here', start: 4.4, end: 4.8, prob: 0.9 },
      ],
    }],
  });
  captionsStage(runDir, { config });
  await renderStage(runDir, { attempt: 0, config });
}

test('clean candidate: QA has no hard gaps; delivery ships the mp4', { timeout: 600_000 }, async () => {
  await setupRun();
  const report = await qaMeasure(runDir, { attempt: 0, config, referenceDir });
  assert.ok(!report.gaps.some((g) => g.severity === 'hard'),
    `unexpected hard gaps: ${JSON.stringify(report.gaps)}`);
  const res = deliver(runDir, outputDir, { attempt: 0, config });
  assert.notEqual(res.decision, 'refuse');
  assert.ok(existsSync(res.deliveredPath));
  assert.match(res.deliveredPath, /speech-20260610-120000-test\.mp4$/);
});

test('(b) forced black frames: hard gap → refuse, report only, no mp4', { timeout: 600_000 }, async () => {
  // doctor the candidate: 1 s of forced black in the middle, audio untouched
  const good = join(runDir, 'candidate_a0.mp4');
  const bad = join(runDir, 'candidate_a1.mp4');
  await ffmpeg(['-i', good,
    '-vf', "drawbox=c=black:t=fill:enable='between(t,1,2)'",
    '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'copy', bad]);

  const report = await qaMeasure(runDir, { attempt: 1, config, referenceDir });
  assert.ok(report.gaps.some((g) => g.signal === 'black_frames' && g.severity === 'hard'),
    JSON.stringify(report.gaps));

  const freshOut = join(base, 'output-refused');
  const res = deliver(runDir, freshOut, { attempt: 1, config });
  assert.equal(res.decision, 'refuse');
  assert.ok(existsSync(res.reportPath));
  assert.match(readFileSync(res.reportPath, 'utf8'), /hard gaps block delivery/);
  assert.ok(!readdirSync(freshOut).some((f) => f.endsWith('.mp4')), 'no mp4 must be delivered');
});

test('(c) non-converging soft gap terminates within ceiling via no-progress guard', async () => {
  let renders = 0;
  const softReport = (attempt, score) => ({
    verdict: 'gap', attempt, score,
    signals: {}, gaps: [{ signal: 'framing', severity: 'soft', observed: 0.7, target: 0.9, suggested_fix: 'retune' }],
  });
  const { best, attempts, decision } = await runQaLoop({
    renderAndMeasure: async (attempt) => { renders += 1; return softReport(attempt, 80); }, // never improves
    fix: async () => true,
    maxFixAttempts: 5,
  });
  assert.ok(attempts <= 5);
  assert.equal(attempts, 2, 'no-progress guard must stop after 2 non-improving fixes');
  assert.equal(renders, 3); // initial + 2 fix renders — never unbounded
  assert.equal(decision, 'deliver-with-report');
  assert.equal(best.score, 80);
});

test('loop ceiling: slowly improving soft gap stops at 5 fix attempts', async () => {
  let renders = 0;
  const { attempts } = await runQaLoop({
    renderAndMeasure: async (attempt) => {
      renders += 1;
      return {
        verdict: 'gap', attempt, score: 50 + renders, signals: {},
        gaps: [{ signal: 'framing', severity: 'soft', observed: 0, target: 1, suggested_fix: 'x' }],
      };
    },
    fix: async () => true,
    maxFixAttempts: 5,
  });
  assert.equal(attempts, 5);
  assert.equal(renders, 6); // initial + 5
});

test('hard gap at ceiling → refuse decision', () => {
  assert.equal(deliveryDecision({
    verdict: 'gap', gaps: [{ severity: 'hard' }, { severity: 'soft' }],
  }), 'refuse');
  assert.equal(deliveryDecision({ verdict: 'pass', gaps: [] }), 'deliver');
});

test('runs pruning keeps the newest N', () => {
  for (const id of ['20260101-000000-aaaa', '20260102-000000-bbbb', '20260103-000000-cccc']) {
    mkdirSync(join(runsRoot, id), { recursive: true });
  }
  const doomed = pruneRuns(runsRoot, 2);
  assert.ok(doomed.length >= 2); // includes our test run dir + oldest stubs
  const left = readdirSync(runsRoot);
  assert.equal(left.length, 2);
});
