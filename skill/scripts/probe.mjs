#!/usr/bin/env node
// Stage 0 — probe & conditional normalize.
// Usage: node probe.mjs <input> <runDir>
// Writes <runDir>/probe.json (+ <runDir>/normalized.mkv when repair is needed).
// Exit 2 = input rejected (one-line user-facing message on stdout).
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ffprobeJson, ffmpeg } from './lib/ffmpeg.mjs';
import { parseRational, rationalToFloat, nearestStandardRate } from './lib/timecode.mjs';
import { writeArtifact, loadConfig } from './lib/artifacts.mjs';

const SAFE_VCODECS = new Set(['h264', 'hevc', 'vp9', 'av1']);

function streamRotation(stream) {
  for (const sd of stream.side_data_list ?? []) {
    if (sd.rotation !== undefined) return Math.round(Number(sd.rotation));
  }
  const tag = stream.tags?.rotate;
  if (tag !== undefined) return Math.round(Number(tag));
  return 0;
}

async function probeFile(path) {
  const data = await ffprobeJson(['-show_streams', '-show_format', path]);
  const video = (data.streams ?? []).filter((s) => s.codec_type === 'video');
  const audio = (data.streams ?? []).filter((s) => s.codec_type === 'audio');
  return { format: data.format ?? {}, video, audio };
}

export async function probe(inputPath, runDir, { config } = {}) {
  if (!config) config = loadConfig(process.cwd(), { runDir }).config;
  const input = resolve(inputPath);
  mkdirSync(runDir, { recursive: true });

  const meta = await probeFile(input);
  if (!meta.video.length) {
    return { rejected: `input has no video stream: ${input}` };
  }
  const v = meta.video[0]; // Assumption (§5.1): single video stream; multi-stream uses v:0
  const durationS = Number(meta.format.duration ?? v.duration ?? 0);
  if (!durationS || durationS <= 0) {
    return { rejected: `cannot determine input duration: ${input}` };
  }
  const maxS = config.input.max_minutes * 60;
  if (durationS > maxS) {
    return { rejected: `input is ${(durationS / 60).toFixed(1)} min — over the ${config.input.max_minutes} min limit. Trim it down and retry.` };
  }

  const r = parseRational(v.r_frame_rate);
  const avg = parseRational(v.avg_frame_rate);
  if (!r && !avg) return { rejected: `cannot determine frame rate: ${input}` };
  const rF = r ? rationalToFloat(r) : null;
  const avgF = avg ? rationalToFloat(avg) : null;
  const vfr = Boolean(rF && avgF && Math.abs(rF - avgF) / avgF > 0.005);

  const rotation = streamRotation(v);
  const rotated = ((rotation % 180) + 180) % 180 !== 0 ? 'swap' : (rotation !== 0 ? 'bake' : null);
  const exotic = !SAFE_VCODECS.has(v.codec_name);
  const needsNormalize = vfr || rotation !== 0 || exotic;

  let readPath = input;
  let normalizedPath = null;
  let fpsRat = vfr ? nearestStandardRate(avgF ?? rF) : (r ?? avg);

  if (needsNormalize) {
    normalizedPath = join(runDir, 'normalized.mkv'); // mkv: any source audio codec stream-copies
    const args = ['-i', input,
      '-map', '0:v:0', '-map', '0:a?',
      '-c:v', 'libx264', '-crf', '12', '-preset', 'medium', '-pix_fmt', 'yuv420p',
      '-fps_mode', 'cfr', '-r', `${fpsRat.num}/${fpsRat.den}`,
      '-c:a', 'copy',
      normalizedPath];
    await ffmpeg(args); // ffmpeg autorotates on re-encode: display matrix is baked in
    readPath = normalizedPath;
  }

  // Final metadata always read from the file downstream stages will consume.
  const finalMeta = await probeFile(readPath);
  const fv = finalMeta.video[0];
  const finalR = parseRational(fv.r_frame_rate) ?? fpsRat;
  const width = fv.width;
  const height = fv.height;
  // After normalization rotation is baked; otherwise rotation is 0 by construction here.
  const displayW = needsNormalize ? width : (rotated === 'swap' ? height : width);
  const displayH = needsNormalize ? height : (rotated === 'swap' ? width : height);
  const finalDuration = Number(finalMeta.format.duration ?? durationS);

  const audioStreams = finalMeta.audio.map((a) => ({
    index: a.index,
    codec: a.codec_name,
    sample_rate: Number(a.sample_rate),
    channels: a.channels,
  }));

  let audioSource = config.audio.track;
  if (audioSource !== 'mix') {
    const pos = audioStreams.findIndex((a) => a.index === audioSource);
    if (pos === -1) {
      return { rejected: `configured audio.track stream index ${audioSource} not found (streams: ${audioStreams.map((a) => a.index).join(', ') || 'none'})` };
    }
  }
  if (!audioStreams.length) {
    return { rejected: `input has no audio stream: ${input}` };
  }

  const artifact = {
    fps_num: finalR.num,
    fps_den: finalR.den,
    fps: rationalToFloat(finalR),
    width,
    height,
    rotation,
    display_width: displayW,
    display_height: displayH,
    duration_s: finalDuration,
    vfr,
    normalized_path: normalizedPath,
    audio_streams: audioStreams,
    audio_source: audioSource,
    source: input,
  };
  writeArtifact('probe', join(runDir, 'probe.json'), artifact);
  return { artifact };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, runDir] = process.argv.slice(2);
  if (!input || !runDir) {
    console.error('usage: probe.mjs <input> <runDir>');
    process.exit(1);
  }
  try {
    const res = await probe(input, runDir);
    if (res.rejected) {
      console.log(`REJECTED: ${res.rejected}`);
      process.exit(2);
    }
    const a = res.artifact;
    console.log(`probe ok: ${a.display_width}x${a.display_height} @ ${a.fps_num}/${a.fps_den} fps, ` +
      `${a.duration_s.toFixed(2)}s, ${a.audio_streams.length} audio stream(s)` +
      (a.normalized_path ? ` — normalized (vfr=${a.vfr}, rotation=${a.rotation})` : ''));
  } catch (err) {
    console.error(`probe failed: ${err.message}`);
    process.exit(1);
  }
}
