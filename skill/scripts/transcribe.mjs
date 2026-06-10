#!/usr/bin/env node
// Stage 1 bridge — shared-mixdown WAV extraction + faster-whisper via the venv.
// Usage: node transcribe.mjs <runDir>
// Reads <runDir>/probe.json; writes <runDir>/audio_16k.wav + <runDir>/transcript.json.
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readArtifact, loadConfig, SKILL_ROOT } from './lib/artifacts.mjs';
import { extractWhisperWav } from './lib/ffmpeg.mjs';
import { runPython } from './lib/venv.mjs';

export async function transcribe(runDir, { config } = {}) {
  if (!config) config = loadConfig(process.cwd(), { runDir }).config;
  const probe = readArtifact('probe', join(runDir, 'probe.json'));
  const media = probe.normalized_path ?? probe.source;

  const wav = join(runDir, 'audio_16k.wav');
  await extractWhisperWav(media, probe, wav);

  const localModel = join(SKILL_ROOT, 'models', 'whisper', config.whisper.model);
  const modelRef = existsSync(localModel) ? localModel : config.whisper.model;

  const outPath = join(runDir, 'transcript.json');
  const script = join(dirname(fileURLToPath(import.meta.url)), 'transcribe.py');
  const { stdout } = await runPython(script, [wav, outPath, '--model', modelRef, '--language', config.whisper.language]);

  const transcript = readArtifact('transcript', outPath);
  return { transcript, summary: stdout.trim() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [runDir] = process.argv.slice(2);
  if (!runDir) {
    console.error('usage: transcribe.mjs <runDir>');
    process.exit(1);
  }
  try {
    const { summary } = await transcribe(runDir);
    console.log(summary);
  } catch (err) {
    console.error(`transcribe failed: ${err.message}`);
    process.exit(1);
  }
}
