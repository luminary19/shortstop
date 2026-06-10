#!/usr/bin/env node
// Dependency health check. Prints an actionable report (what is missing + the
// exact fix command), never a stack trace. Exit 0 = all green.
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_ROOT } from './lib/artifacts.mjs';
import { resolveFfmpeg } from './lib/ffmpeg.mjs';
import { findSystemPython, venvReady, pythonImportOk, capturePython } from './lib/venv.mjs';

export const YUNET_PATH = join(SKILL_ROOT, 'models', 'yunet.onnx');
export const WHISPER_DIR = join(SKILL_ROOT, 'models', 'whisper');
export const READY_FLAG = join(SKILL_ROOT, '.shortstop-ready');
const FONT_PATH = join(SKILL_ROOT, 'assets', 'fonts', 'CaptionFont.ttf');

export async function runChecks() {
  const checks = [];
  const add = (name, ok, detail, fix = null) => checks.push({ name, ok, detail, fix });

  // Node version
  const [nodeMajor] = process.versions.node.split('.').map(Number);
  add('node >= 20', nodeMajor >= 20, `v${process.versions.node}`,
    'install Node 20+ (https://nodejs.org or nvm install 20)');

  // npm deps
  let depsOk = true;
  try { await import('execa'); await import('ajv'); } catch { depsOk = false; }
  add('npm dependencies', depsOk, depsOk ? 'execa, ajv importable' : 'missing',
    `npm install --prefix ${SKILL_ROOT}`);

  // ffmpeg / ffprobe (functional validation incl. encode smoke test)
  try {
    const ff = await resolveFfmpeg();
    add('ffmpeg + ffprobe', true, `${ff.origin}: ${ff.version}`);
  } catch (err) {
    add('ffmpeg + ffprobe', false, err.message.split('\n')[0],
      `npm install --prefix ${SKILL_ROOT}  (or: apt install ffmpeg)`);
  }

  // python
  const py = await findSystemPython();
  add('python3 >= 3.9', Boolean(py && !py.tooOld), py ? `python ${py.version}` : 'not found',
    'apt install python3 python3-venv');

  // venv + imports
  add('python venv', venvReady(), venvReady() ? '.venv present' : 'missing',
    `node ${join(SKILL_ROOT, 'scripts', 'bootstrap.mjs')}`);
  if (venvReady()) {
    const fw = await pythonImportOk('faster_whisper');
    add('faster-whisper', fw, fw ? await capturePython('import faster_whisper; print(faster_whisper.__version__)').catch(() => 'importable') : 'import fails',
      `${join(SKILL_ROOT, '.venv', 'bin', 'pip')} install "faster-whisper>=1.1,<2"`);
    const cv = await pythonImportOk('cv2');
    add('opencv (headless)', cv, cv ? await capturePython('import cv2; print(cv2.__version__)').catch(() => 'importable') : 'import fails',
      `${join(SKILL_ROOT, '.venv', 'bin', 'pip')} install "opencv-python-headless>=4.10,<5"`);
  }

  // models
  const yunetOk = existsSync(YUNET_PATH) && statSync(YUNET_PATH).size > 100_000 &&
    !readFileSync(YUNET_PATH).subarray(0, 12).toString().startsWith('version http');
  add('YuNet face model', yunetOk, yunetOk ? YUNET_PATH : 'missing or LFS pointer',
    `node ${join(SKILL_ROOT, 'scripts', 'bootstrap.mjs')}`);
  const whisperOk = existsSync(WHISPER_DIR) && statSync(WHISPER_DIR).isDirectory();
  add('Whisper model cache', whisperOk, whisperOk ? WHISPER_DIR : 'not pre-downloaded (will download on first transcription)',
    `node ${join(SKILL_ROOT, 'scripts', 'bootstrap.mjs')}`);

  // bundled font
  add('caption font', existsSync(FONT_PATH), FONT_PATH,
    're-clone the skill folder: assets/fonts/CaptionFont.ttf is bundled');

  return checks;
}

export function reportChecks(checks) {
  let allOk = true;
  for (const c of checks) {
    const mark = c.ok ? '✔' : '✘';
    console.log(`${mark} ${c.name.padEnd(22)} ${c.detail}`);
    if (!c.ok && c.fix) {
      console.log(`   fix: ${c.fix}`);
      allOk = false;
    }
  }
  return allOk;
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const checks = await runChecks();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(checks, null, 2));
    process.exit(checks.every((c) => c.ok) ? 0 : 1);
  }
  const ok = reportChecks(checks);
  console.log(ok ? '\nall green — shortstop is ready.' : '\nsome checks failed — apply the fixes above, then re-run doctor.');
  process.exit(ok ? 0 : 1);
}
