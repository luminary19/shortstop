#!/usr/bin/env node
// Delivery per §8: pass → mp4; soft gaps only → mp4 + QA_REPORT.md;
// any hard gap → QA_REPORT.md only (never ship a broken clip).
// Never clobbers prior outputs (run-id suffix). Prunes old runs on success.
// Usage: node deliver.mjs <runDir> <outputDir> --attempt N
import { join, basename, dirname } from 'node:path';
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readArtifact, loadConfig } from './lib/artifacts.mjs';
import { hasHardGaps, deliveryDecision } from './lib/qaloop.mjs';

function qaReportMd(report, { candidatePath, delivered }) {
  const lines = [
    '# Shortstop QA report',
    '',
    `- verdict: **${report.verdict}** (score ${report.score}/100, attempt ${report.attempt})`,
    `- delivered: ${delivered ? 'yes — soft gaps remain, listed below' : '**no — hard gaps block delivery**'}`,
    `- best candidate: \`${candidatePath}\``,
    '',
    '| signal | severity | observed | target | suggested fix |',
    '|---|---|---|---|---|',
    ...report.gaps.map((g) =>
      `| ${g.signal} | ${g.severity} | ${JSON.stringify(g.observed)} | ${JSON.stringify(g.target)} | ${g.suggested_fix} |`),
    '',
    '## Signals',
    '```json',
    JSON.stringify(report.signals, null, 2),
    '```',
  ];
  return lines.join('\n') + '\n';
}

export function pruneRuns(runsRoot, keepLast) {
  if (!existsSync(runsRoot)) return [];
  const runs = readdirSync(runsRoot)
    .map((d) => join(runsRoot, d))
    .filter((p) => statSync(p).isDirectory())
    .sort(); // run-ids are YYYYMMDD-HHmmss-xxxx → lexicographic == chronological
  const doomed = runs.slice(0, Math.max(0, runs.length - keepLast));
  for (const d of doomed) rmSync(d, { recursive: true, force: true });
  return doomed;
}

export function deliver(runDir, outputDir, { attempt = 0, config } = {}) {
  if (!config) config = loadConfig(process.cwd(), { runDir }).config;
  const probe = readArtifact('probe', join(runDir, 'probe.json'));
  const report = readArtifact('qa_report', join(runDir, `qa_report_a${attempt}.json`));
  const candidate = join(runDir, `candidate_a${attempt}.mp4`);
  // shorts multi-clip: runDir may be runs/<id>/clip<N> — name outputs
  // <stem>-<id>-clip<N>.mp4 and prune at the real runs root, not inside the run.
  const isClipDir = /^clip\d+$/.test(basename(runDir));
  const runId = isClipDir ? `${basename(dirname(runDir))}-${basename(runDir)}` : basename(runDir);
  const runsRoot = isClipDir ? dirname(dirname(runDir)) : dirname(runDir);
  const stem = basename(probe.source).replace(/\.[^.]+$/, '');
  mkdirSync(outputDir, { recursive: true });

  const decision = deliveryDecision(report);
  const outMp4 = join(outputDir, `${stem}-${runId}.mp4`);
  const outReport = join(outputDir, `${stem}-${runId}.QA_REPORT.md`);

  let deliveredPath = null;
  let reportPath = null;
  if (decision === 'deliver' || decision === 'deliver-with-report') {
    copyFileSync(candidate, outMp4); // distinct run-id ⇒ never clobbers prior edits
    deliveredPath = outMp4;
  }
  if (decision !== 'deliver') {
    writeFileSync(outReport, qaReportMd(report, { candidatePath: candidate, delivered: decision === 'deliver-with-report' }));
    reportPath = outReport;
  }
  if (deliveredPath) {
    pruneRuns(runsRoot, config.runs.keep_last);
  }
  return { decision, deliveredPath, reportPath, hardGaps: hasHardGaps(report) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const [runDir, outputDir] = args;
  const attempt = args.includes('--attempt') ? Number(args[args.indexOf('--attempt') + 1]) : 0;
  if (!runDir || !outputDir) {
    console.error('usage: deliver.mjs <runDir> <outputDir> --attempt N');
    process.exit(1);
  }
  try {
    const res = deliver(runDir, outputDir, { attempt });
    if (res.decision === 'refuse') {
      console.log(`REFUSED: hard QA gaps remain — report written to ${res.reportPath} (no mp4 delivered)`);
      process.exit(5);
    }
    console.log(`delivered: ${res.deliveredPath}` + (res.reportPath ? ` (+ ${res.reportPath})` : ''));
  } catch (err) {
    console.error(`deliver failed: ${err.message}`);
    process.exit(1);
  }
}
