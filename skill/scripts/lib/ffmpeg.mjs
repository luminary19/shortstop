// Locate and validate ffmpeg/ffprobe; shared audio-source resolution so Whisper
// and the render hear the identical mixdown; centralized filtergraph escaping.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { run, capture, tryRun } from './spawn.mjs';

const require = createRequire(import.meta.url);

const REQUIRED_FILTERS = ['silencedetect', 'loudnorm', 'subtitles', 'astats', 'blackdetect', 'freezedetect', 'sendcmd', 'amix'];

function staticPaths() {
  let ffmpeg = null;
  let ffprobe = null;
  try { ffmpeg = require('ffmpeg-static'); } catch { /* not installed */ }
  try { ffprobe = require('ffprobe-static').path; } catch { /* not installed */ }
  return { ffmpeg, ffprobe };
}

// Functional validation: -version must run AND a tiny real encode must succeed
// (this catches statically-built binaries that segfault on real work).
export async function validateFfmpeg(ffmpegBin) {
  const v = await tryRun(ffmpegBin, ['-version']);
  if (v.failed) return { ok: false, reason: `-version failed: ${v.shortMessage}` };
  const filters = await tryRun(ffmpegBin, ['-hide_banner', '-filters']);
  if (filters.failed) return { ok: false, reason: '-filters failed' };
  const missing = REQUIRED_FILTERS.filter((f) => !filters.stdout.includes(` ${f} `));
  if (missing.length) return { ok: false, reason: `missing filters: ${missing.join(', ')}` };
  const smoke = await tryRun(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10:duration=0.3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'null', '-',
  ]);
  if (smoke.failed) return { ok: false, reason: `encode smoke test failed: ${smoke.shortMessage}` };
  const version = v.stdout.split('\n')[0];
  return { ok: true, version };
}

let cached = null;

// Resolve ffmpeg+ffprobe: static npm binaries first, PATH fallback. Throws with
// an actionable message when neither works.
export async function resolveFfmpeg() {
  if (cached) return cached;
  const candidates = [];
  const stat = staticPaths();
  if (stat.ffmpeg && stat.ffprobe && existsSync(stat.ffmpeg) && existsSync(stat.ffprobe)) {
    candidates.push({ ffmpeg: stat.ffmpeg, ffprobe: stat.ffprobe, origin: 'static' });
  }
  candidates.push({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', origin: 'PATH' });

  const failures = [];
  for (const c of candidates) {
    const check = await validateFfmpeg(c.ffmpeg).catch((e) => ({ ok: false, reason: e.message }));
    const probeCheck = check.ok ? await tryRun(c.ffprobe, ['-version']) : { failed: true };
    if (check.ok && !probeCheck.failed) {
      cached = { ...c, version: check.version };
      return cached;
    }
    failures.push(`${c.origin}: ${check.reason ?? 'ffprobe missing'}`);
  }
  const installHint = process.platform === 'win32' ? 'winget install Gyan.FFmpeg' : 'apt install ffmpeg';
  throw new Error(
    'no working ffmpeg found.\n' + failures.map((f) => `  - ${f}`).join('\n') +
    `\nfix: re-run \`npm install\` in the skill folder, or install ffmpeg (${installHint}) with libass/loudnorm support.`,
  );
}

export async function ffmpeg(args, opts = {}) {
  const { ffmpeg: bin } = await resolveFfmpeg();
  return run(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args], opts);
}

// ffmpeg, but keep stderr (silencedetect/loudnorm/blackdetect report there).
export async function ffmpegInfo(args, opts = {}) {
  const { ffmpeg: bin } = await resolveFfmpeg();
  return run(bin, ['-hide_banner', '-y', ...args], { ...opts, all: true });
}

export async function ffprobe(args, opts = {}) {
  const { ffprobe: bin } = await resolveFfmpeg();
  return capture(bin, ['-v', 'error', ...args], opts);
}

export async function ffprobeJson(args, opts = {}) {
  const out = await ffprobe(['-of', 'json', ...args], opts);
  return JSON.parse(out);
}

// ---- shared audio-source resolution (Decision Record: same mixdown for whisper & render)

// Given probe data, returns ffmpeg args fragments selecting/mixing the audio source.
// `inputLabel` is the input index of the media file in the ffmpeg invocation.
export function audioSourceFilter(probe, inputIndex = 0) {
  const streams = probe.audio_streams;
  if (!streams.length) throw new Error('input has no audio stream');
  if (probe.audio_source === 'mix' && streams.length > 1) {
    const inputs = streams.map((s, i) => `[${inputIndex}:a:${i}]`).join('');
    return {
      filter: `${inputs}amix=inputs=${streams.length}:duration=longest:normalize=0[aout]`,
      label: '[aout]',
      usesFilter: true,
    };
  }
  const streamSpec = probe.audio_source === 'mix' ? 'a:0' : `a:${resolveStreamPos(streams, probe.audio_source)}`;
  return { filter: null, label: `${inputIndex}:${streamSpec}`, usesFilter: false };
}

function resolveStreamPos(streams, absIndex) {
  const pos = streams.findIndex((s) => s.index === absIndex);
  if (pos === -1) throw new Error(`audio_source stream index ${absIndex} not present in input`);
  return pos;
}

// Extract the canonical Whisper input: 16 kHz mono WAV through the shared mixdown.
export async function extractWhisperWav(mediaPath, probe, outWav) {
  const src = audioSourceFilter(probe, 0);
  const args = ['-i', mediaPath];
  if (src.usesFilter) {
    args.push('-filter_complex', src.filter, '-map', src.label);
  } else {
    args.push('-map', src.label);
  }
  args.push('-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-vn', outWav);
  await ffmpeg(args);
  return outWav;
}

// Escape a path for use inside a filtergraph option value (subtitles=, sendcmd=).
// Values pass through two parsers: the filtergraph parser (one \ level), then the
// option-value parser (a second level). Backslash path separators would need 4x
// escaping, so use forward slashes (ffmpeg accepts them on Windows); the drive
// colon needs both levels (\\:).
export function escapeFilterPath(p) {
  return p
    .replaceAll('\\', '/')
    .replaceAll(':', '\\\\:')
    .replaceAll("'", "\\'")
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll(',', '\\,')
    .replaceAll(';', '\\;');
}

export function resetFfmpegCache() { cached = null; }
