#!/usr/bin/env node
// Phase 11 clean-machine simulation (run on demand, not part of `npm test`):
// copy the bare distributable to a fresh dir (no node_modules/.venv/models),
// bootstrap it there, then run the full pipeline through the COPY's scripts.
// Prints CLEAN-INSTALL E2E: PASS on success.
import { execa } from 'execa';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateFixtures, FIXTURE_DIR } from './fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'shortstop-clean-'));
console.log(`[clean-e2e] workspace: ${tmp}`);

// 1. bare copy of the distributable
const skillDir = join(tmp, 'skill');
await execa('rsync', ['-a',
  '--exclude=node_modules', '--exclude=.venv', '--exclude=models',
  '--exclude=.shortstop-ready', '--exclude=package-lock.json',
  join(ROOT, 'skill') + '/', skillDir + '/']);
console.log('[clean-e2e] bare skill copied (no deps, no venv, no models)');

// 2. bootstrap from scratch (npm install, venv, model downloads) + doctor gate
await execa('node', [join(skillDir, 'scripts', 'bootstrap.mjs')], { stdio: 'inherit' });
if (!existsSync(join(skillDir, '.shortstop-ready'))) throw new Error('.shortstop-ready not written');
await execa('node', [join(skillDir, 'scripts', 'doctor.mjs')], { stdio: 'inherit' });

// 3. scratch project + fixtures
await generateFixtures();
const project = join(tmp, 'project');
for (const d of ['input', 'output', 'reference', 'runs']) mkdirSync(join(project, d), { recursive: true });
copyFileSync(join(FIXTURE_DIR, 'speech.mp4'), join(project, 'input', 'take1.mp4'));
copyFileSync(join(FIXTURE_DIR, 'reference.mp4'), join(project, 'reference', 'style.mp4'));

// 4. full pipeline through the COPY's modules (imported by file URL)
const mod = (p) => import(pathToFileURL(join(skillDir, 'scripts', p)).href);
const [{ probe }, { transcribe }, { silenceStage }, { track }, { buildEdl },
  { captionsStage }, { renderStage }, { qaMeasure }, { deliver }, artifacts] = await Promise.all([
  mod('probe.mjs'), mod('transcribe.mjs'), mod('silence.mjs'), mod('track.mjs'),
  mod('build_edl.mjs'), mod('build_captions.mjs'), mod('render.mjs'), mod('qa.mjs'),
  mod('deliver.mjs'), mod('lib/artifacts.mjs'),
]);
const { config } = artifacts.loadConfig(project);
const runDir = join(project, 'runs', '20990101-000000-cln1');

const { artifact: p } = await probe(join(project, 'input', 'take1.mp4'), runDir);
console.log('[clean-e2e] probe ok');
await transcribe(runDir, { config });
console.log('[clean-e2e] transcribe ok');
await silenceStage(runDir, { config });
await track(runDir, { config });
console.log('[clean-e2e] silence + track ok');

const transcript = artifacts.readArtifact('transcript', join(runDir, 'transcript.json'));
const silence = artifacts.readArtifact('silence', join(runDir, 'silence.json'));
// scripted stand-in for Claude's stage 4 (same heuristic as tests/e2e.test.mjs)
const words = transcript.segments.flatMap((s) => s.words);
const groups = [[words[0]]];
for (let i = 1; i < words.length; i++) {
  if (words[i].start - words[i - 1].end > config.cut.max_pause_s) groups.push([]);
  groups[groups.length - 1].push(words[i]);
}
const isFiller = (g) => g.length === 1 && config.cut.fillers.includes(g[0].word.toLowerCase().replace(/[^a-z]/g, ''));
const keep = groups.filter((g) => !isFiller(g)).map((g) => ({
  start: g[0].start, end: g[g.length - 1].end, reason: 'speech group',
}));
const removed = groups.filter(isFiller).map((g) => ({
  start: g[0].start, end: g[g.length - 1].end, kind: 'filler', reason: `filler "${g[0].word}"`,
}));
const result = buildEdl({ source: p.source, keep, removed, notes: 'clean-install smoke' },
  { probe: p, silence, transcript, config });
if (!result.ok) throw new Error('EDL rejected: ' + JSON.stringify(result.reasons));
artifacts.writeArtifact('edl', join(runDir, 'edl.json'), result.edl);
console.log('[clean-e2e] edl ok');

captionsStage(runDir, { config });
await renderStage(runDir, { attempt: 0, config });
console.log('[clean-e2e] render ok');
const report = await qaMeasure(runDir, { attempt: 0, config, referenceDir: join(project, 'reference') });
if (report.gaps.some((g) => g.severity === 'hard')) {
  throw new Error('hard QA gaps: ' + JSON.stringify(report.gaps));
}
const res = deliver(runDir, join(project, 'output'), { attempt: 0, config });
if (res.decision === 'refuse' || !existsSync(res.deliveredPath)) throw new Error('delivery failed');
console.log(`[clean-e2e] delivered ${res.deliveredPath}`);
console.log('CLEAN-INSTALL E2E: PASS');
if (!process.argv.includes('--keep')) rmSync(tmp, { recursive: true, force: true });
