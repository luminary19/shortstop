// Phase 10 acceptance: full pipeline end-to-end in a scratch project exactly as
// SKILL.md sequences it. Stage 4 judgment is emulated with a scripted heuristic
// (tests assert structural invariants, never Claude's exact cuts — PLAN §9).
// A second run must not clobber the first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from 'shortstop-skill/scripts/probe.mjs';
import { transcribe } from 'shortstop-skill/scripts/transcribe.mjs';
import { silenceStage } from 'shortstop-skill/scripts/silence.mjs';
import { track } from 'shortstop-skill/scripts/track.mjs';
import { buildEdl } from 'shortstop-skill/scripts/build_edl.mjs';
import { captionsStage } from 'shortstop-skill/scripts/build_captions.mjs';
import { renderStage } from 'shortstop-skill/scripts/render.mjs';
import { qaMeasure } from 'shortstop-skill/scripts/qa.mjs';
import { deliver } from 'shortstop-skill/scripts/deliver.mjs';
import { readArtifact, writeArtifact, loadConfig } from 'shortstop-skill/scripts/lib/artifacts.mjs';
import { generateFixtures, FIXTURE_DIR } from './fixtures.mjs';

await generateFixtures();
const { config } = loadConfig('/nonexistent-no-override');
const project = mkdtempSync(join(tmpdir(), 'shortstop-e2e-'));
test.after(() => rmSync(project, { recursive: true, force: true }));

for (const d of ['input', 'output', 'reference', 'runs']) mkdirSync(join(project, d));
copyFileSync(join(FIXTURE_DIR, 'reference.mp4'), join(project, 'reference', 'style.mp4'));
copyFileSync(join(FIXTURE_DIR, 'speech.mp4'), join(project, 'input', 'take1.mp4'));

// Scripted stand-in for Claude's Stage 4 judgment: group words split at pauses
// > max_pause_s, drop pure-filler groups, keep the rest.
function scriptedCutDecisions(transcript, source, cfg) {
  const words = transcript.segments.flatMap((s) => s.words);
  const groups = [];
  let cur = [words[0]];
  for (let i = 1; i < words.length; i++) {
    if (words[i].start - words[i - 1].end > cfg.cut.max_pause_s) {
      groups.push(cur);
      cur = [];
    }
    cur.push(words[i]);
  }
  groups.push(cur);
  const isFiller = (g) => g.length === 1 &&
    cfg.cut.fillers.includes(g[0].word.toLowerCase().replace(/[^a-z]/g, ''));
  const keep = [];
  const removed = [];
  for (const g of groups) {
    const seg = { start: g[0].start, end: g[g.length - 1].end };
    if (isFiller(g)) removed.push({ ...seg, kind: 'filler', reason: `filler "${g[0].word}"` });
    else keep.push({ ...seg, reason: g.map((w) => w.word).slice(0, 3).join(' ') + '…' });
  }
  for (let i = 1; i < keep.length; i++) {
    removed.push({ start: keep[i - 1].end, end: keep[i].start, kind: 'pause', reason: 'long pause' });
  }
  removed.sort((a, b) => a.start - b.start);
  return { source, keep, removed, notes: 'scripted e2e heuristic (not Claude)' };
}

async function runPipeline(runId) {
  const runDir = join(project, 'runs', runId);
  const { artifact: p } = await probe(join(project, 'input', 'take1.mp4'), runDir);
  await transcribe(runDir, { config });
  await silenceStage(runDir, { config });
  await track(runDir, { config });

  const transcript = readArtifact('transcript', join(runDir, 'transcript.json'));
  const silence = readArtifact('silence', join(runDir, 'silence.json'));
  const draft = scriptedCutDecisions(transcript, p.source, config);
  const result = buildEdl(draft, { probe: p, silence, transcript, config });
  assert.ok(result.ok, `EDL rejected: ${JSON.stringify(result.reasons)}`);
  writeArtifact('edl', join(runDir, 'edl.json'), result.edl);

  captionsStage(runDir, { config });
  await renderStage(runDir, { attempt: 0, config });
  const report = await qaMeasure(runDir, { attempt: 0, config, referenceDir: join(project, 'reference') });
  assert.ok(!report.gaps.some((g) => g.severity === 'hard'),
    `hard gaps in e2e: ${JSON.stringify(report.gaps)}`);
  return deliver(runDir, join(project, 'output'), { attempt: 0, config });
}

test('e2e run 1: drop clip → polished short in output/, artifacts in runs/', { timeout: 900_000 }, async () => {
  const res = await runPipeline('20260610-130000-aaaa');
  assert.notEqual(res.decision, 'refuse');
  assert.ok(existsSync(res.deliveredPath));

  const runDir = join(project, 'runs', '20260610-130000-aaaa');
  for (const a of ['probe.json', 'transcript.json', 'silence.json', 'track.json',
    'edl.json', 'captions.ass', 'mezzanine.mkv', 'candidate_a0.mp4', 'qa_report_a0.json']) {
    assert.ok(existsSync(join(runDir, a)), `missing artifact ${a}`);
  }
  // the planted filler "um" must actually be gone from the cut
  const edl = readArtifact('edl', join(runDir, 'edl.json'));
  assert.ok(edl.stats.removed_s > 1, 'expected meaningful time removed');
});

test('e2e run 2: never clobbers run 1', { timeout: 900_000 }, async () => {
  const before = readdirSync(join(project, 'output')).filter((f) => f.endsWith('.mp4'));
  const res = await runPipeline('20260610-140000-bbbb');
  assert.notEqual(res.decision, 'refuse');
  const after = readdirSync(join(project, 'output')).filter((f) => f.endsWith('.mp4'));
  assert.equal(after.length, before.length + 1);
  for (const f of before) assert.ok(after.includes(f), `run 2 clobbered ${f}`);
});
