#!/usr/bin/env node
// First-run setup (§6). Idempotent; streams progress; writes .shortstop-ready
// recording resolved binary paths + versions.
import { existsSync, mkdirSync, writeFileSync, statSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_ROOT } from './lib/artifacts.mjs';
import { run, tryRun } from './lib/spawn.mjs';

const log = (msg) => console.log(`[bootstrap] ${msg}`);

const YUNET_URLS = [
  'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
  'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
];

async function downloadYunet(dest) {
  if (existsSync(dest) && statSync(dest).size > 100_000) return;
  mkdirSync(join(SKILL_ROOT, 'models'), { recursive: true });
  for (const url of YUNET_URLS) {
    log(`downloading YuNet face model: ${url}`);
    const res = await tryRun('curl', ['-sfL', '--max-time', '300', '-o', dest, url]);
    if (!res.failed && existsSync(dest) && statSync(dest).size > 100_000 &&
        !readFileSync(dest).subarray(0, 12).toString().startsWith('version http')) {
      return;
    }
    rmSync(dest, { force: true });
  }
  throw new Error('could not download YuNet model. fix: download face_detection_yunet_2023mar.onnx manually to models/yunet.onnx');
}

export async function bootstrap() {
  // 1. Node version
  const [nodeMajor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 20) {
    console.error(`Node ${process.versions.node} is too old (need >= 20). fix: nvm install 20`);
    process.exit(1);
  }
  log(`node v${process.versions.node} ok`);

  // 2. npm install (skill deps)
  if (!existsSync(join(SKILL_ROOT, 'node_modules'))) {
    log('installing npm dependencies (ffmpeg-static, ffprobe-static, execa, ajv)…');
    await run('npm', ['install', '--no-fund', '--no-audit'], { cwd: SKILL_ROOT, stdio: 'inherit' });
  } else {
    log('npm dependencies present');
  }

  // 3. ffmpeg validation (functional, incl. encode smoke test)
  const { resolveFfmpeg } = await import('./lib/ffmpeg.mjs');
  const ff = await resolveFfmpeg();
  log(`ffmpeg ok (${ff.origin}): ${ff.version}`);

  // 4–5. python + venv + pip deps
  const { createVenv, venvPython } = await import('./lib/venv.mjs');
  await createVenv(log);
  log('python venv ready');

  // 6a. YuNet model
  const yunetPath = join(SKILL_ROOT, 'models', 'yunet.onnx');
  await downloadYunet(yunetPath);
  log('YuNet model ready');

  // 6b. Whisper model pre-download (size from config; one-time, can take minutes)
  const { loadConfig } = await import('./lib/artifacts.mjs');
  const { config } = loadConfig();
  const whisperDir = join(SKILL_ROOT, 'models', 'whisper', config.whisper.model);
  if (!existsSync(whisperDir)) {
    log(`pre-downloading whisper "${config.whisper.model}" model (one-time, a few hundred MB)…`);
    await run(venvPython(), ['-c',
      `from faster_whisper.utils import download_model; download_model(${JSON.stringify(config.whisper.model)}, output_dir=${JSON.stringify(whisperDir)})`,
    ], { stdio: 'inherit' });
  }
  log('whisper model ready');

  // 7. doctor
  const { runChecks, reportChecks } = await import('./doctor.mjs');
  const checks = await runChecks();
  const ok = reportChecks(checks);
  if (!ok) {
    console.error('\nbootstrap finished but doctor reports problems — see fixes above.');
    process.exit(1);
  }

  // 8. ready flag with resolved paths + versions
  const ready = {
    bootstrapped_at: new Date().toISOString(),
    node: process.versions.node,
    ffmpeg: { path: ff.ffmpeg, origin: ff.origin, version: ff.version },
    ffprobe: ff.ffprobe,
    python: venvPython(),
    whisper_model: config.whisper.model,
  };
  writeFileSync(join(SKILL_ROOT, '.shortstop-ready'), JSON.stringify(ready, null, 2) + '\n');
  log('.shortstop-ready written — setup complete.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  bootstrap().catch((err) => {
    console.error(`[bootstrap] FAILED: ${err.message}`);
    process.exit(1);
  });
}
