#!/usr/bin/env node
// Stage 6 — ffmpeg render, two passes.
//   Pass A: per-keep trim + 10 ms audio micro-fades + concat → MKV/PCM mezzanine.
//   Pass B: tracked crop (sendcmd) | blur-pad, lanczos scale, caption burn,
//           two-pass loudnorm + aresample, +faststart.
// QA fixes that only touch audio/captions re-run pass B alone (EDL hash gate).
// Usage: node render.mjs <runDir> [--attempt N]
import { join } from 'node:path';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readArtifact, loadConfig, SKILL_ROOT } from './lib/artifacts.mjs';
import { ffmpeg, ffmpegInfo, ffprobeJson, audioSourceFilter, escapeFilterPath, resolveFfmpeg } from './lib/ffmpeg.mjs';
import { framesToSeconds, parseRational, rationalToFloat } from './lib/timecode.mjs';

const FADE_S = 0.01;

export function keepDurations(edl) {
  return edl.keep.map((k) => k.end - k.start);
}

export function totalKeepS(edl) {
  return keepDurations(edl).reduce((a, b) => a + b, 0);
}

// ---------- pass A: cut & concat mezzanine ----------

export async function renderPassA(runDir, { probe, edl, config }) {
  const media = probe.normalized_path ?? probe.source;
  const K = edl.keep.length;
  const fade = config.audio.junction_fade_s ?? FADE_S;
  const src = audioSourceFilter(probe, 0);

  const parts = [];
  if (src.usesFilter) parts.push(src.filter.replace('[aout]', '[amixed]'));
  const audioRoot = src.usesFilter ? '[amixed]' : `[${src.label}]`;
  parts.push(`[0:v]split=${K}${edl.keep.map((_, i) => `[vs${i}]`).join('')}`);
  parts.push(`${audioRoot}asplit=${K}${edl.keep.map((_, i) => `[as${i}]`).join('')}`);

  edl.keep.forEach((k, i) => {
    const dur = k.end - k.start;
    parts.push(`[vs${i}]trim=start=${k.start.toFixed(6)}:end=${k.end.toFixed(6)},setpts=PTS-STARTPTS[v${i}]`);
    const fades = dur > 4 * fade
      ? `,afade=t=in:st=0:d=${fade},afade=t=out:st=${(dur - fade).toFixed(6)}:d=${fade}`
      : '';
    parts.push(`[as${i}]atrim=start=${k.start.toFixed(6)}:end=${k.end.toFixed(6)},asetpts=PTS-STARTPTS${fades}[a${i}]`);
  });
  parts.push(`${edl.keep.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${K}:v=1:a=1[vc][ac]`);

  const mezzPath = join(runDir, 'mezzanine.mkv');
  await ffmpeg([
    '-i', media,
    '-filter_complex', parts.join(';'),
    '-map', '[vc]', '-map', '[ac]',
    '-c:v', 'libx264', '-crf', String(config.render.mezzanine_crf), '-preset', 'fast', '-pix_fmt', 'yuv420p',
    '-fps_mode', 'cfr', '-r', `${probe.fps_num}/${probe.fps_den}`,
    '-c:a', 'pcm_s16le',
    mezzPath,
  ]);
  return mezzPath;
}

// ---------- crop path remap: source time → output time, per output frame ----------

export function buildCropCmdFile(track, edl, probe, outPath) {
  const { fps_num: num, fps_den: den } = probe;
  const cp = track.crop_path;
  const xAt = (tSrc) => {
    if (cp.length === 1) return cp[0].x;
    if (tSrc <= cp[0].t) return cp[0].x;
    if (tSrc >= cp[cp.length - 1].t) return cp[cp.length - 1].x;
    let i = 1;
    while (i < cp.length && cp[i].t < tSrc) i++;
    const a = cp[i - 1];
    const b = cp[i];
    const f = (tSrc - a.t) / (b.t - a.t || 1);
    return a.x + f * (b.x - a.x);
  };

  const totalFrames = Math.round(totalKeepS({ keep: edl.keep }) * num / den);
  const lines = [];
  let offset = 0;
  let ki = 0;
  let keepStartFrame = 0;
  for (let f = 0; f < totalFrames; f++) {
    const tOut = framesToSeconds(f, num, den);
    // advance to the keep containing tOut
    while (ki < edl.keep.length - 1 && tOut >= offset + (edl.keep[ki].end - edl.keep[ki].start) - 1e-9) {
      offset += edl.keep[ki].end - edl.keep[ki].start;
      ki++;
    }
    const tSrc = edl.keep[ki].start + (tOut - offset);
    const x = Math.max(0, Math.round(xAt(tSrc) / 2) * 2);
    lines.push(`${tOut.toFixed(5)} crop@dyn x ${x};`);
  }
  writeFileSync(outPath, lines.join('\n') + '\n');
  return outPath;
}

// ---------- pass B: crop/scale/captions + loudnorm ----------

async function measureLoudness(path, config) {
  const res = await ffmpegInfo([
    '-loglevel', 'info', '-i', path,
    '-af', `loudnorm=I=${config.audio.target_lufs}:TP=${config.audio.true_peak_db}:LRA=11:print_format=json`,
    '-f', 'null', '-',
  ]);
  const text = res.all ?? res.stderr;
  const m = text.lastIndexOf('{');
  if (m === -1) throw new Error('loudnorm measure pass produced no JSON');
  return JSON.parse(text.slice(m, text.lastIndexOf('}') + 1));
}

export async function renderPassB(runDir, { probe, edl, track, config, attempt, audioOverrides = {} }) {
  const mezzPath = join(runDir, 'mezzanine.mkv');
  const is916 = config.aspect.mode === '9:16';
  const outW = config.aspect.out_width;
  const outH = config.aspect.out_height;

  // video chain
  const vparts = [];
  if (is916) {
    if (track.mode === 'face') {
      const cmdFile = buildCropCmdFile(track, edl, probe, join(runDir, 'crop.cmd'));
      const x0 = Math.max(0, Math.round(track.crop_path[0].x / 2) * 2);
      const y0 = track.crop_path[0].y;
      vparts.push(`sendcmd=f=${escapeFilterPath(cmdFile)}`);
      vparts.push(`crop@dyn=w=${track.crop_w}:h=${track.crop_h}:x=${x0}:y=${y0}`);
      vparts.push(`scale=${outW}:${outH}:flags=lanczos`);
    } else if (config.aspect.no_face_fallback === 'center-crop') {
      const p = track.crop_path[0];
      vparts.push(`crop=w=${track.crop_w}:h=${track.crop_h}:x=${p.x}:y=${p.y}`);
      vparts.push(`scale=${outW}:${outH}:flags=lanczos`);
    } else {
      // blur-pad: full frame fit over a blurred, zoomed copy of itself
      vparts.push(`split[bp_fg][bp_bg];[bp_bg]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},gblur=sigma=24[bp_b];` +
        `[bp_fg]scale=${outW}:${outH}:force_original_aspect_ratio=decrease:flags=lanczos[bp_f];` +
        `[bp_b][bp_f]overlay=(W-w)/2:(H-h)/2`);
    }
  }
  const assPath = join(runDir, 'captions.ass');
  if (config.captions.enabled && existsSync(assPath)) {
    const fontsDir = join(SKILL_ROOT, 'assets', 'fonts');
    vparts.push(`subtitles=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(fontsDir)}`);
  }

  // audio chain: two-pass loudnorm (linear) + resample back to source rate
  const target = audioOverrides.target_lufs ?? config.audio.target_lufs;
  const tp = audioOverrides.true_peak_db ?? config.audio.true_peak_db;
  const measured = await measureLoudness(mezzPath, config);
  const srcRate = probe.audio_streams[0].sample_rate;
  let aChain =
    `loudnorm=I=${target}:TP=${tp}:LRA=11:` +
    `measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:` +
    `measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:` +
    `offset=${measured.target_offset}:linear=true`;
  // Linear loudnorm caps its gain so peaks stay under TP; high-crest audio then
  // undershoots the integrated target. Predict the deficit and make it up with
  // a limiter catching only the peaks.
  const wantedGain = target - Number(measured.input_i);
  const allowedGain = tp - Number(measured.input_tp);
  const deficit = wantedGain - Math.min(wantedGain, allowedGain);
  if (deficit > 0.25) {
    const limitLin = Math.pow(10, tp / 20).toFixed(4);
    aChain += `,volume=${deficit.toFixed(2)}dB,alimiter=limit=${limitLin}:attack=5:release=100:level=0`;
  }
  aChain += `,aresample=${srcRate}`;

  const candidate = join(runDir, `candidate_a${attempt}.mp4`);
  const args = ['-i', mezzPath];
  if (vparts.length) args.push('-vf', vparts.join(','));
  args.push(
    '-af', aChain,
    '-c:v', 'libx264', '-crf', String(config.render.crf), '-preset', config.render.preset, '-pix_fmt', 'yuv420p',
    '-fps_mode', 'cfr', '-r', `${probe.fps_num}/${probe.fps_den}`,
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    candidate,
  );
  await ffmpeg(args);
  return candidate;
}

// ---------- post-render assertions (fail the stage, not QA) ----------

export async function assertCandidate(candidate, { probe, edl, config }) {
  const data = await ffprobeJson(['-show_streams', '-show_format', candidate]);
  const v = data.streams.find((s) => s.codec_type === 'video');
  const a = data.streams.find((s) => s.codec_type === 'audio');
  const problems = [];
  if (!v) problems.push('no video stream');
  if (!a) problems.push('no audio stream');
  if (v) {
    const r = parseRational(v.r_frame_rate);
    if (r.num * probe.fps_den !== probe.fps_num * r.den) {
      problems.push(`fps ${v.r_frame_rate} != expected ${probe.fps_num}/${probe.fps_den}`);
    }
    const expW = config.aspect.mode === '9:16' ? config.aspect.out_width : probe.display_width;
    const expH = config.aspect.mode === '9:16' ? config.aspect.out_height : probe.display_height;
    if (v.width !== expW || v.height !== expH) {
      problems.push(`dims ${v.width}x${v.height} != expected ${expW}x${expH}`);
    }
  }
  const expectedS = totalKeepS(edl);
  const durS = Number(data.format.duration);
  const tolS = framesToSeconds(config.qa.duration_tolerance_frames + 1, probe.fps_num, probe.fps_den);
  if (Math.abs(durS - expectedS) > tolS) {
    problems.push(`duration ${durS.toFixed(3)}s != Σkeep ${expectedS.toFixed(3)}s (tol ${tolS.toFixed(3)}s)`);
  }
  if (a && Number(a.sample_rate) !== probe.audio_streams[0].sample_rate) {
    problems.push(`audio rate ${a.sample_rate} != source ${probe.audio_streams[0].sample_rate}`);
  }
  if (problems.length) {
    throw new Error(`post-render assertions failed for ${candidate}:\n  ` + problems.join('\n  '));
  }
  return { duration_s: durS };
}

// ---------- stage entry: incremental pass-A gating by EDL hash ----------

function edlHash(edl) {
  return createHash('sha256').update(JSON.stringify(edl.keep)).digest('hex');
}

export async function renderStage(runDir, { attempt = 0, config, audioOverrides } = {}) {
  if (!config) config = loadConfig().config;
  await resolveFfmpeg();
  const probe = readArtifact('probe', join(runDir, 'probe.json'));
  const edl = readArtifact('edl', join(runDir, 'edl.json'));
  const track = config.aspect.mode === '9:16'
    ? readArtifact('track', join(runDir, 'track.json'))
    : { mode: 'fallback', crop_path: [{ t: 0, x: 0, y: 0 }], crop_w: 2, crop_h: 2, detections: [], sample_fps: 5, coverage: 0 };

  const statePath = join(runDir, 'render_state.json');
  const hash = edlHash(edl);
  let passARan = false;
  const prior = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  if (!existsSync(join(runDir, 'mezzanine.mkv')) || prior?.edl_hash !== hash) {
    await renderPassA(runDir, { probe, edl, config });
    passARan = true;
  }
  const candidate = await renderPassB(runDir, { probe, edl, track, config, attempt, audioOverrides });
  const { duration_s } = await assertCandidate(candidate, { probe, edl, config });
  writeFileSync(statePath, JSON.stringify({ edl_hash: hash, last_attempt: attempt }, null, 2));
  return { candidate, duration_s, passARan };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const runDir = args[0];
  const attempt = args.includes('--attempt') ? Number(args[args.indexOf('--attempt') + 1]) : 0;
  if (!runDir) {
    console.error('usage: render.mjs <runDir> [--attempt N]');
    process.exit(1);
  }
  try {
    const { candidate, duration_s, passARan } = await renderStage(runDir, { attempt });
    console.log(`render ok: ${candidate} (${duration_s.toFixed(2)}s${passARan ? '' : ', pass B only'})`);
  } catch (err) {
    console.error(`render failed: ${err.message}`);
    process.exit(1);
  }
}
