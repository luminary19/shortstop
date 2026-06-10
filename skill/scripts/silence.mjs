#!/usr/bin/env node
// Stage 2 — auto-calibrated silence map.
// Calibrates the silencedetect threshold to the clip's measured noise floor
// (p10 of 0.5 s window RMS + offset, clamped to [-50, -20] dB), then detects.
// Usage: node silence.mjs <runDir>
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readArtifact, writeArtifact, loadConfig } from './lib/artifacts.mjs';
import { ffmpeg, ffmpegInfo, ffprobe, audioSourceFilter } from './lib/ffmpeg.mjs';

const WINDOW_S = 0.5;
const CLAMP_LO = -50;
const CLAMP_HI = -20;
const FLOOR_SANITY_DB = -25; // floor above this ⇒ no real quiet floor ⇒ calibration failed
const NEG_INF_DB = -120;     // stand-in for digital-silence windows

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

// Measure per-window peak level over a mono WAV; return the p10 noise floor in dB.
// Peak (not RMS) because silencedetect's threshold is compared against sample
// amplitude — an RMS-derived floor sits below real noise peaks and detects nothing.
async function measureNoiseFloor(wavPath, sampleRate) {
  const n = Math.round(sampleRate * WINDOW_S);
  const res = await ffmpegInfo([
    '-loglevel', 'error',
    '-i', wavPath,
    '-af', `asetnsamples=n=${n}:p=0,astats=metadata=1:reset=1,` +
      'ametadata=mode=print:key=lavfi.astats.Overall.Peak_level:file=-',
    '-f', 'null', '-',
  ]);
  const values = [];
  for (const line of res.stdout.split('\n')) {
    const m = /lavfi\.astats\.Overall\.Peak_level=(-?[\d.]+|-inf)/.exec(line);
    if (m) values.push(m[1] === '-inf' ? NEG_INF_DB : parseFloat(m[1]));
  }
  if (values.length < 4) return null;
  values.sort((a, b) => a - b);
  return percentile(values, 0.10);
}

async function detectSilences(wavPath, thresholdDb, minSilenceS, durationS) {
  const res = await ffmpegInfo([
    '-loglevel', 'info',
    '-i', wavPath,
    '-af', `silencedetect=n=${thresholdDb}dB:d=${minSilenceS}`,
    '-f', 'null', '-',
  ]);
  const text = res.all ?? res.stderr;
  const regions = [];
  let pendingStart = null;
  for (const line of text.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (s) pendingStart = Math.max(0, parseFloat(s[1]));
    if (e && pendingStart !== null) {
      const end = Math.min(parseFloat(e[1]), durationS);
      if (end > pendingStart) regions.push({ start: pendingStart, end, dur: end - pendingStart });
      pendingStart = null;
    }
  }
  if (pendingStart !== null && durationS - pendingStart > 0) {
    regions.push({ start: pendingStart, end: durationS, dur: durationS - pendingStart });
  }
  regions.sort((a, b) => a.start - b.start);
  return regions;
}

// Low-level analysis on a single-stream audio file (used directly by tests).
export async function analyzeSilence(audioPath, config) {
  const durationS = parseFloat(await ffprobe(['-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath]));
  const sampleRate = parseInt(await ffprobe(['-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', audioPath]), 10);

  let noiseFloor = null;
  let calibrated = false;
  let threshold = config.silence.fallback_threshold_db;
  if (config.silence.auto_calibrate) {
    noiseFloor = await measureNoiseFloor(audioPath, sampleRate);
    if (noiseFloor !== null && noiseFloor <= FLOOR_SANITY_DB) {
      threshold = Math.min(CLAMP_HI, Math.max(CLAMP_LO, noiseFloor + config.silence.offset_db));
      calibrated = true;
    }
  }

  const regions = await detectSilences(audioPath, threshold, config.silence.min_silence_s, durationS);
  return {
    noise_floor_db: noiseFloor,
    threshold_db: threshold,
    min_silence_s: config.silence.min_silence_s,
    calibrated,
    regions,
  };
}

// Artifact-level stage: shared mixdown from probe.json → silence.json.
export async function silenceStage(runDir, { config } = {}) {
  if (!config) config = loadConfig(process.cwd(), { runDir }).config;
  const probe = readArtifact('probe', join(runDir, 'probe.json'));
  const media = probe.normalized_path ?? probe.source;

  // Extract the shared mixdown at source rate so thresholds reflect what the viewer hears.
  const tmp = mkdtempSync(join(tmpdir(), 'shortstop-sil-'));
  const wav = join(tmp, 'audio.wav');
  try {
    const src = audioSourceFilter(probe, 0);
    const args = ['-i', media];
    if (src.usesFilter) args.push('-filter_complex', src.filter, '-map', src.label);
    else args.push('-map', src.label);
    args.push('-ac', '1', '-c:a', 'pcm_s16le', '-vn', wav);
    await ffmpeg(args);

    const artifact = await analyzeSilence(wav, config);
    writeArtifact('silence', join(runDir, 'silence.json'), artifact);
    return artifact;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [runDir] = process.argv.slice(2);
  if (!runDir) {
    console.error('usage: silence.mjs <runDir>');
    process.exit(1);
  }
  try {
    const a = await silenceStage(runDir);
    console.log(`silence map: ${a.regions.length} region(s), threshold ${a.threshold_db.toFixed(1)} dB ` +
      `(${a.calibrated ? `calibrated, floor ${a.noise_floor_db.toFixed(1)} dB` : 'fallback — calibration unavailable'})`);
  } catch (err) {
    console.error(`silence stage failed: ${err.message}`);
    process.exit(1);
  }
}
