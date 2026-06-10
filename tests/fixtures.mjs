#!/usr/bin/env node
// Deterministic fixture generator (§4.2). Builds every test clip from espeak-ng + ffmpeg
// so ground-truth cut points, silences, and motion paths are known by construction.
// Usage: node tests/fixtures.mjs [--force]
import { execa } from 'execa';
import ffmpegPath from 'ffmpeg-static';
import { path as ffprobePath } from 'ffprobe-static';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, 'fixtures');
const ASSET_DIR = join(FIXTURE_DIR, 'assets');
const MANIFEST = join(FIXTURE_DIR, 'fixtures.json');

const AR = 48000; // all fixture audio at 48 kHz mono s16

// Scripted lines with planted defects (ground truth for Stage 4/5 tests).
// Gaps >= 0.5 s are the two "planted silences" Stage 2 must find.
const PHRASES = [
  { id: 'p1', text: 'Hello everyone and welcome back to the channel.', gapAfter: 1.2, kind: 'keep' },
  { id: 'p2', text: 'Um.', gapAfter: 0.3, kind: 'filler' },
  { id: 'p3', text: 'Today we are going', gapAfter: 0.3, kind: 'false_start' },
  { id: 'p4', text: 'Today we are going to build something special.', gapAfter: 1.5, kind: 'keep' },
  { id: 'p5', text: "Let's get started right away.", gapAfter: 0.4, kind: 'keep' },
];

const FACE_URLS = [
  'https://raw.githubusercontent.com/scikit-image/scikit-image/main/skimage/data/astronaut.png',
  'https://raw.githubusercontent.com/opencv/opencv/4.x/samples/data/lena.jpg',
];

async function ff(args, opts = {}) {
  return execa(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], opts);
}

async function probeDuration(path) {
  const { stdout } = await execa(ffprobePath, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path,
  ]);
  return parseFloat(stdout.trim());
}

async function espeakPhrase(text, outWav) {
  const raw = outWav + '.raw.wav';
  await execa('espeak-ng', ['-v', 'en-us', '-s', '150', '-w', raw, text]);
  // Trim espeak's leading/trailing silence so planted gap boundaries are exact,
  // then resample to the common fixture format.
  await ff([
    '-i', raw,
    '-af',
    'silenceremove=start_periods=1:start_threshold=-50dB,areverse,' +
    'silenceremove=start_periods=1:start_threshold=-50dB,areverse,' +
    `aresample=${AR}`,
    '-ac', '1', '-c:a', 'pcm_s16le', outWav,
  ]);
  return probeDuration(outWav);
}

async function makeSilence(dur, outWav) {
  await ff(['-f', 'lavfi', '-i', `anullsrc=r=${AR}:cl=mono:d=${dur}`, '-c:a', 'pcm_s16le', outWav]);
}

async function concatWavs(paths, outWav) {
  const list = outWav + '.txt';
  writeFileSync(list, paths.map((p) => `file '${p}'\n`).join(''));
  await ff(['-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'pcm_s16le', outWav]);
}

async function buildSpeech() {
  const parts = [];
  const groundTruth = { phrases: [], silences: [], duration_s: 0 };
  let t = 0;
  for (const p of PHRASES) {
    const wav = join(ASSET_DIR, `${p.id}.wav`);
    const dur = await espeakPhrase(p.text, wav);
    groundTruth.phrases.push({ ...p, start: t, end: t + dur });
    parts.push(wav);
    t += dur;
    if (p.gapAfter > 0) {
      const sil = join(ASSET_DIR, `${p.id}.gap.wav`);
      await makeSilence(p.gapAfter, sil);
      if (p.gapAfter >= 0.5) groundTruth.silences.push({ start: t, end: t + p.gapAfter });
      parts.push(sil);
      t += p.gapAfter;
    }
  }
  groundTruth.duration_s = t;

  const speechWav = join(FIXTURE_DIR, 'speech.wav');
  await concatWavs(parts, speechWav);

  // speech.mp4: testsrc2 1080p30 video under the speech track (clean CFR input).
  await ff([
    '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30:duration=${t.toFixed(3)}`,
    '-i', speechWav,
    '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-shortest',
    join(FIXTURE_DIR, 'speech.mp4'),
  ]);

  // Noisy variant: same speech over a -40 dB pink-noise floor (calibration test).
  await ff([
    '-i', speechWav,
    '-f', 'lavfi', '-i', `anoisesrc=colour=pink:sample_rate=${AR}:amplitude=0.01:duration=${t.toFixed(3)}`,
    '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]',
    '-map', '[a]', '-c:a', 'pcm_s16le',
    join(FIXTURE_DIR, 'speech_noisy.wav'),
  ]);

  // Music stand-in: wall-to-wall tone mix, no silence anywhere (calibration-failure path).
  await ff([
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${AR}:duration=20`,
    '-f', 'lavfi', '-i', `sine=frequency=587:sample_rate=${AR}:duration=20`,
    '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0,volume=0.5[a]',
    '-map', '[a]', '-c:a', 'pcm_s16le',
    join(FIXTURE_DIR, 'music.wav'),
  ]);

  return groundTruth;
}

async function fetchFaceImage() {
  const dest = join(ASSET_DIR, 'face.png');
  if (existsSync(dest)) return dest;
  for (const url of FACE_URLS) {
    try {
      await execa('curl', ['-sfL', '--max-time', '60', '-o', dest, url]);
      return dest;
    } catch { /* try next */ }
  }
  throw new Error('could not download a CC0 face image for the tracking fixture');
}

// Face drifts horizontally at a known constant velocity → tracking ground truth.
const FACE_MOTION = { x0: 200, y: 240, speed: 40, faceHeight: 600, duration: 10 };

async function buildFace(speechWav) {
  const img = await fetchFaceImage();
  const { x0, y, speed, faceHeight, duration } = FACE_MOTION;
  await ff([
    '-f', 'lavfi', '-i', `color=c=0x303030:size=1920x1080:rate=30:duration=${duration}`,
    '-loop', '1', '-i', img,
    '-i', speechWav,
    '-filter_complex',
    `[1:v]scale=-1:${faceHeight}[face];[0:v][face]overlay=x='${x0}+${speed}*t':y=${y}:shortest=1[v]`,
    '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-t', String(duration),
    join(FIXTURE_DIR, 'face.mp4'),
  ]);
}

async function buildPathological() {
  // VFR: two segments at different frame rates, stream-copy concatenated.
  // (.mp4 segments — this ffmpeg-static build segfaults on mpegts demux.)
  const segA = join(ASSET_DIR, 'vfr_a.mp4');
  const segB = join(ASSET_DIR, 'vfr_b.mp4');
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3',
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${AR}:duration=3`,
    '-c:v', 'libx264', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', segA]);
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15:duration=3',
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${AR}:duration=3`,
    '-c:v', 'libx264', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', segB]);
  const list = join(ASSET_DIR, 'vfr.txt');
  writeFileSync(list, `file '${segA}'\nfile '${segB}'\n`);
  await ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', join(FIXTURE_DIR, 'vfr.mp4')]);

  // Rotated: display-matrix side data says 90°.
  await ff(['-display_rotation', '90', '-i', join(FIXTURE_DIR, 'speech.mp4'),
    '-c', 'copy', join(FIXTURE_DIR, 'rotated.mp4')]);

  // 21-minute clip: 60 s low-res base × 21, stream-copied (cap-rejection test).
  const base = join(ASSET_DIR, 'long_base.mp4');
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=60',
    '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=${AR}:duration=60`,
    '-c:v', 'libx264', '-crf', '32', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', base]);
  const longList = join(ASSET_DIR, 'long.txt');
  writeFileSync(longList, Array(21).fill(`file '${base}'\n`).join(''));
  await ff(['-f', 'concat', '-safe', '0', '-i', longList, '-c', 'copy', join(FIXTURE_DIR, 'long21.mp4')]);

  // NTSC 29.97: exact 30000/1001 rational fps.
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30000/1001:duration=6',
    '-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=${AR}:duration=6`,
    '-c:v', 'libx264', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    join(FIXTURE_DIR, 'ntsc.mp4')]);
}

// Reference exemplar: low-res 9:16 clip with visible jump cuts and -14 LUFS audio.
async function buildReference(speechWav) {
  const segs = [];
  for (let i = 0; i < 6; i++) {
    const seg = join(ASSET_DIR, `ref_${i}.mp4`);
    // Different testsrc2 start offsets → hard visual discontinuity at each junction.
    await ff(['-f', 'lavfi', '-i', `testsrc2=size=540x960:rate=30:duration=5`,
      '-vf', `hue=h=${i * 60}`, '-ss', '0',
      '-c:v', 'libx264', '-crf', '28', '-pix_fmt', 'yuv420p', seg]);
    segs.push(seg);
  }
  const list = join(ASSET_DIR, 'ref.txt');
  writeFileSync(list, segs.map((s) => `file '${s}'\n`).join(''));
  const silent = join(ASSET_DIR, 'ref_silent.mp4');
  await ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent]);
  await ff([
    '-i', silent, '-stream_loop', '2', '-i', speechWav,
    '-af', `loudnorm=I=-14:TP=-1:LRA=11,aresample=${AR}`,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest',
    join(FIXTURE_DIR, 'reference.mp4'),
  ]);
}

export async function generateFixtures({ force = false } = {}) {
  if (!force && existsSync(MANIFEST)) {
    return JSON.parse(readFileSync(MANIFEST, 'utf8'));
  }
  mkdirSync(ASSET_DIR, { recursive: true });
  const speech = await buildSpeech();
  const speechWav = join(FIXTURE_DIR, 'speech.wav');
  await buildFace(speechWav);
  await buildPathological();
  await buildReference(speechWav);
  const manifest = {
    generated_at: new Date().toISOString(),
    speech,
    face_motion: FACE_MOTION,
    files: ['speech.wav', 'speech.mp4', 'speech_noisy.wav', 'music.wav', 'face.mp4',
      'vfr.mp4', 'rotated.mp4', 'long21.mp4', 'ntsc.mp4', 'reference.mp4'],
  };
  for (const f of manifest.files) {
    if (!existsSync(join(FIXTURE_DIR, f))) throw new Error(`fixture missing after generation: ${f}`);
  }
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = await generateFixtures({ force: process.argv.includes('--force') });
  console.log(`fixtures ready in ${FIXTURE_DIR}`);
  console.log(`speech duration: ${manifest.speech.duration_s.toFixed(2)}s, ` +
    `planted silences: ${manifest.speech.silences.map((s) => `${s.start.toFixed(2)}–${s.end.toFixed(2)}`).join(', ')}`);
}
