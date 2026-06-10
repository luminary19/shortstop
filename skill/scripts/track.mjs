#!/usr/bin/env node
// Stage 3 bridge — runs track.py in the venv against the probed media.
// Usage: node track.mjs <runDir>
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArtifact, loadConfig, SKILL_ROOT } from './lib/artifacts.mjs';
import { runPython } from './lib/venv.mjs';

export async function track(runDir, { config } = {}) {
  if (!config) config = loadConfig(process.cwd(), { runDir }).config;
  const probe = readArtifact('probe', join(runDir, 'probe.json'));
  const media = probe.normalized_path ?? probe.source;
  const outPath = join(runDir, 'track.json');
  const script = join(dirname(fileURLToPath(import.meta.url)), 'track.py');
  const model = join(SKILL_ROOT, 'models', 'yunet.onnx');
  const { stdout } = await runPython(script, [media, outPath, '--model', model, '--sample-fps', '5']);
  const artifact = readArtifact('track', outPath);
  return { artifact, summary: stdout.trim() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [runDir] = process.argv.slice(2);
  if (!runDir) {
    console.error('usage: track.mjs <runDir>');
    process.exit(1);
  }
  try {
    const { summary } = await track(runDir);
    console.log(summary);
  } catch (err) {
    console.error(`track failed: ${err.message}`);
    process.exit(1);
  }
}
