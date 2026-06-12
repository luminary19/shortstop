#!/usr/bin/env node
// Dependency health check. Prints an actionable report (what is missing + the
// exact fix command), never a stack trace. Exit 0 = all green.
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_ROOT } from './lib/artifacts.mjs';
import { resolveFfmpeg } from './lib/ffmpeg.mjs';
import { findSystemPython, venvReady, venvPython, pythonImportOk, capturePython } from './lib/venv.mjs';
import { tryRun } from './lib/spawn.mjs';

const IS_WINDOWS = process.platform === 'win32';
const PYTHON_FIX = IS_WINDOWS
  ? 'install Python 3 from https://python.org (check "Add to PATH") or `winget install Python.Python.3.12`'
  : 'apt install python3 python3-venv';
const FFMPEG_FIX = IS_WINDOWS ? 'winget install Gyan.FFmpeg' : 'apt install ffmpeg';

export const YUNET_PATH = join(SKILL_ROOT, 'models', 'yunet.onnx');
export const WHISPER_DIR = join(SKILL_ROOT, 'models', 'whisper');
export const READY_FLAG = join(SKILL_ROOT, '.shortstop-ready');
const FONT_PATH = join(SKILL_ROOT, 'assets', 'fonts', 'CaptionFont.ttf');

// espeak-ng — used by tests/fixtures.mjs to synthesize ground-truth test clips;
// the runtime pipeline never needs it. Checks PATH, $ESPEAK_NG_PATH, and the
// Windows MSI's default install dir (the MSI updates the machine PATH, which
// already-running shells don't see).
export async function findEspeak() {
  const candidates = [];
  if (process.env.ESPEAK_NG_PATH) candidates.push(process.env.ESPEAK_NG_PATH);
  candidates.push('espeak-ng');
  if (IS_WINDOWS) {
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (root) candidates.push(join(root, 'eSpeak NG', 'espeak-ng.exe'));
    }
  }
  for (const bin of candidates) {
    const res = await tryRun(bin, ['--version']);
    if (!res.failed && /eSpeak/i.test(res.stdout ?? '')) {
      return { bin, version: res.stdout.trim().split(/\s+Data at:/)[0] };
    }
  }
  return null;
}

export async function runChecks() {
  const checks = [];
  const add = (name, ok, detail, fix = null, optional = false) => checks.push({ name, ok, detail, fix, optional });

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
      `npm install --prefix ${SKILL_ROOT}  (or: ${FFMPEG_FIX})`);
  }

  // python
  const py = await findSystemPython();
  add('python3 >= 3.9', Boolean(py && !py.tooOld), py ? `python ${py.version}` : 'not found',
    PYTHON_FIX);

  // venv + imports
  add('python venv', venvReady(), venvReady() ? '.venv present' : 'missing',
    `node ${join(SKILL_ROOT, 'scripts', 'bootstrap.mjs')}`);
  if (venvReady()) {
    const fw = await pythonImportOk('faster_whisper');
    add('faster-whisper', fw, fw ? await capturePython('import faster_whisper; print(faster_whisper.__version__)').catch(() => 'importable') : 'import fails',
      `${venvPython()} -m pip install "faster-whisper>=1.1,<2"`);
    const cv = await pythonImportOk('cv2');
    add('opencv (headless)', cv, cv ? await capturePython('import cv2; print(cv2.__version__)').catch(() => 'importable') : 'import fails',
      `${venvPython()} -m pip install "opencv-python-headless>=4.10,<5"`);
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

  // espeak-ng (optional): only the test fixture generator needs it
  const espeak = await findEspeak();
  add('espeak-ng (dev/tests)', Boolean(espeak),
    espeak ? `${espeak.version} (${espeak.bin})` : 'not found — only needed to generate test fixtures',
    IS_WINDOWS ? 'winget install eSpeak-NG.eSpeak-NG' : 'apt install espeak-ng', true);

  return checks;
}

export function reportChecks(checks) {
  let allOk = true;
  for (const c of checks) {
    const mark = c.ok ? '✔' : (c.optional ? '–' : '✘');
    console.log(`${mark} ${c.name.padEnd(22)} ${c.detail}`);
    if (!c.ok && c.fix) {
      console.log(`   fix: ${c.fix}`);
      if (!c.optional) allOk = false;
    }
  }
  return allOk;
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const checks = await runChecks();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(checks, null, 2));
    process.exit(checks.every((c) => c.ok || c.optional) ? 0 : 1);
  }
  const ok = reportChecks(checks);
  console.log(ok ? '\nall green — shortstop is ready.' : '\nsome checks failed — apply the fixes above, then re-run doctor.');
  process.exit(ok ? 0 : 1);
}
