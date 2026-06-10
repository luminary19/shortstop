#!/usr/bin/env node
// Stage 7 — deterministic QA measurement. Gap *decisions* are Claude's (§8);
// this script only measures and reports.
// Usage: node qa.mjs <runDir> --attempt N [--reference-dir <dir>]
import { join, dirname, basename } from 'node:path';
import { existsSync, readdirSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readArtifact, writeArtifact, loadConfig, SKILL_ROOT } from './lib/artifacts.mjs';
import { ffmpegInfo, ffprobeJson } from './lib/ffmpeg.mjs';
import { runPython } from './lib/venv.mjs';
import { framesToSeconds } from './lib/timecode.mjs';
import { totalKeepS } from './render.mjs';

const VIDEO_EXT = /\.(mp4|mov|mkv|webm|m4v)$/i;

// Playbook prerequisite: a style-exemplar reference clip is required (§5.8).
export function ensureReference(referenceDir) {
  const files = existsSync(referenceDir)
    ? readdirSync(referenceDir).filter((f) => VIDEO_EXT.test(f))
    : [];
  if (!files.length) {
    throw new Error(
      `reference/ has no video clip (looked in ${referenceDir}). ` +
      'Add one finished Short you like as a style exemplar (e.g. reference/style.mp4) and re-run.',
    );
  }
  return join(referenceDir, files.sort()[0]);
}

async function measureLoudnessOf(path) {
  const res = await ffmpegInfo(['-loglevel', 'info', '-i', path,
    '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-']);
  const text = res.all ?? res.stderr;
  const j = JSON.parse(text.slice(text.lastIndexOf('{'), text.lastIndexOf('}') + 1));
  return { lufs: Number(j.input_i), true_peak_db: Number(j.input_tp), lra: Number(j.input_lra) };
}

async function countSceneCuts(path) {
  const res = await ffmpegInfo(['-loglevel', 'info', '-i', path,
    '-vf', "select='gt(scene,0.4)',metadata=print", '-fps_mode', 'passthrough', '-f', 'null', '-']);
  const text = res.all ?? res.stderr;
  return (text.match(/lavfi\.scene_score/g) ?? []).length;
}

// Reference style signals, cached by content hash (computed once per reference).
export async function referenceSignals(refPath) {
  const cacheDir = join(dirname(refPath), '.shortstop-cache');
  const hash = createHash('sha256').update(readFileSync(refPath)).digest('hex').slice(0, 16);
  const cachePath = join(cacheDir, `${hash}.json`);
  if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, 'utf8'));
  const meta = await ffprobeJson(['-show_format', refPath]);
  const duration = Number(meta.format.duration);
  const loud = await measureLoudnessOf(refPath);
  const cuts = await countSceneCuts(refPath);
  const signals = {
    duration_s: duration, // recorded, NEVER compared (Decision Record #4)
    cuts_per_min: (cuts / duration) * 60,
    lufs: loud.lufs,
    lra: loud.lra,
  };
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(signals, null, 2) + '\n');
  return signals;
}

async function detectVisualDefects(candidate, faceMode) {
  const res = await ffmpegInfo(['-loglevel', 'info', '-i', candidate,
    '-vf', 'blackdetect=d=0.4:pic_th=0.98' + (faceMode ? ',freezedetect=n=-60dB:d=3' : ''),
    '-an', '-f', 'null', '-']);
  const text = res.all ?? res.stderr;
  const black = (text.match(/black_start/g) ?? []).length;
  const freeze = (text.match(/freeze_start/g) ?? []).length;
  return { black_regions: black, freeze_regions: freeze };
}

// Framing on the *rendered* candidate: faces re-detected at 1 fps must sit near
// the horizontal center of the output frame.
async function measureFraming(candidate, config) {
  const out = join(tmpdir(), `shortstop-qa-track-${Date.now()}.json`);
  const model = join(SKILL_ROOT, 'models', 'yunet.onnx');
  const script = join(dirname(fileURLToPath(import.meta.url)), 'track.py');
  await runPython(script, [candidate, out, '--model', model, '--sample-fps', '1']);
  const t = JSON.parse(readFileSync(out, 'utf8'));
  if (!t.detections.length) return { centered_fraction: 0, samples: 0 };
  const meta = await ffprobeJson(['-show_streams', candidate]);
  const v = meta.streams.find((s) => s.codec_type === 'video');
  const tol = config.qa.framing_tolerance * v.width;
  const centered = t.detections.filter((d) => Math.abs(d.cx - v.width / 2) <= tol).length;
  return { centered_fraction: centered / t.detections.length, samples: t.detections.length };
}

function parseAssSanity(assPath, durationS) {
  if (!existsSync(assPath)) return { events: 0, last_end_s: 0, ok: false };
  const lines = readFileSync(assPath, 'utf8').split('\n').filter((l) => l.startsWith('Dialogue:'));
  let lastEnd = 0;
  for (const l of lines) {
    const m = /Dialogue: \d+,[^,]+,(\d+):(\d+):(\d+)\.(\d+),/.exec(l);
    if (m) lastEnd = Math.max(lastEnd, Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100);
  }
  return { events: lines.length, last_end_s: lastEnd, ok: lines.length > 0 && lastEnd <= durationS + 0.5 };
}

export async function qaMeasure(runDir, { attempt = 0, config, referenceDir } = {}) {
  if (!config) config = loadConfig(process.cwd(), { runDir }).config;
  const probe = readArtifact('probe', join(runDir, 'probe.json'));
  const edl = readArtifact('edl', join(runDir, 'edl.json'));
  const track = existsSync(join(runDir, 'track.json'))
    ? readArtifact('track', join(runDir, 'track.json'))
    : null;
  const candidate = join(runDir, `candidate_a${attempt}.mp4`);
  if (!existsSync(candidate)) throw new Error(`candidate not found: ${candidate}`);

  const refPath = ensureReference(referenceDir ?? join(process.cwd(), 'reference'));
  const ref = await referenceSignals(refPath);

  const gaps = [];
  const signals = {};
  const gap = (signal, severity, observed, target, suggested_fix) =>
    gaps.push({ signal, severity, observed, target, suggested_fix });

  // duration integrity (hard)
  const meta = await ffprobeJson(['-show_format', candidate]);
  const durS = Number(meta.format.duration);
  const expectedS = totalKeepS(edl);
  const tolS = framesToSeconds(config.qa.duration_tolerance_frames + 1, probe.fps_num, probe.fps_den);
  signals.duration_s = durS;
  signals.expected_duration_s = expectedS;
  if (Math.abs(durS - expectedS) > tolS) {
    gap('duration', 'hard', durS, expectedS, 'EDL/render mismatch — re-run pass A (full re-render)');
  }

  // loudness + clipping (hard)
  const loud = await measureLoudnessOf(candidate);
  signals.lufs = loud.lufs;
  signals.true_peak_db = loud.true_peak_db;
  if (Math.abs(loud.lufs - config.audio.target_lufs) > config.qa.lufs_tolerance) {
    gap('loudness', 'hard', loud.lufs, config.audio.target_lufs,
      'recompute loudnorm with fresh measured values (pass B re-render)');
  }
  if (loud.true_peak_db > config.audio.true_peak_db + 0.1) {
    gap('clipping', 'hard', loud.true_peak_db, config.audio.true_peak_db,
      'lower loudnorm TP / strengthen limiter (pass B re-render)');
  }

  // visual defects (hard)
  const faceMode = track?.mode === 'face';
  const vis = await detectVisualDefects(candidate, faceMode);
  signals.black_regions = vis.black_regions;
  signals.freeze_regions = vis.freeze_regions;
  if (vis.black_regions > 0) {
    gap('black_frames', 'hard', vis.black_regions, 0, 'inspect EDL boundaries near the black region; re-cut');
  }
  if (vis.freeze_regions > 0) {
    gap('frozen_frames', 'hard', vis.freeze_regions, 0, 'inspect source decode and EDL; re-render pass A');
  }

  // shorts length (soft; disabled when shorts_max_s is null, e.g. longform mode)
  if (config.qa.shorts_max_s != null && durS > config.qa.shorts_max_s) {
    gap('shorts_length', 'soft', durS, config.qa.shorts_max_s,
      'set cut.target_duration_s and re-run cut decisions, or accept the longer cut');
  }

  // framing (soft, face mode only)
  if (faceMode) {
    const framing = await measureFraming(candidate, config);
    signals.framing_centered_fraction = framing.centered_fraction;
    if (framing.samples > 0 && framing.centered_fraction < 0.9) {
      gap('framing', 'soft', framing.centered_fraction, 0.9,
        'retune track smoothing (lower dead-zone / higher spring omega) and re-render pass B');
    }
  }

  // pacing vs reference (soft, advisory — never fix-driving on its own)
  const cutsPerMin = ((edl.keep.length - 1) / durS) * 60;
  signals.cuts_per_min = cutsPerMin;
  signals.reference = ref;
  const lo = ref.cuts_per_min * (1 - config.qa.pacing_tolerance);
  const hi = ref.cuts_per_min * (1 + config.qa.pacing_tolerance);
  if (ref.cuts_per_min > 0 && (cutsPerMin < lo || cutsPerMin > hi)) {
    gap('pacing_advisory', 'soft', cutsPerMin, `${lo.toFixed(1)}–${hi.toFixed(1)}`,
      'advisory only: pacing differs from the reference style; no action required');
  }

  // captions sanity (hard when enabled)
  if (config.captions.enabled) {
    const cap = parseAssSanity(join(runDir, 'captions.ass'), durS);
    signals.caption_events = cap.events;
    if (!cap.ok) {
      gap('captions', 'hard', `${cap.events} events, last_end=${cap.last_end_s.toFixed(2)}s`,
        `>0 events, last_end<=${durS.toFixed(2)}s`, 'regenerate captions from the current EDL');
    }
  }

  // score: 100 - 30/hard - 8/soft (pacing advisory weighs 2)
  const score = Math.max(0, Math.min(100, 100 -
    gaps.reduce((a, g) => a + (g.severity === 'hard' ? 30 : g.signal === 'pacing_advisory' ? 2 : 8), 0)));

  const report = {
    verdict: gaps.length === 0 ? 'pass' : 'gap',
    attempt,
    score,
    signals,
    gaps,
  };
  writeArtifact('qa_report', join(runDir, `qa_report_a${attempt}.json`), report);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const runDir = args[0];
  const attempt = args.includes('--attempt') ? Number(args[args.indexOf('--attempt') + 1]) : 0;
  const refIdx = args.indexOf('--reference-dir');
  const referenceDir = refIdx !== -1 ? args[refIdx + 1] : undefined;
  if (!runDir) {
    console.error('usage: qa.mjs <runDir> --attempt N [--reference-dir <dir>]');
    process.exit(1);
  }
  try {
    const report = await qaMeasure(runDir, { attempt, referenceDir });
    console.log(`qa: verdict=${report.verdict} score=${report.score} gaps=${report.gaps.length}` +
      (report.gaps.length ? '\n' + report.gaps.map((g) => `  [${g.severity}] ${g.signal}: ${g.observed} (target ${g.target}) — ${g.suggested_fix}`).join('\n') : ''));
    process.exit(report.verdict === 'pass' ? 0 : 4);
  } catch (err) {
    console.error(`qa failed: ${err.message}`);
    process.exit(1);
  }
}
