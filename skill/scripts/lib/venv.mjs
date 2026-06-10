// Python venv management: locate python3, create skill-local .venv, run stage
// scripts inside it.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { run, capture, tryRun } from './spawn.mjs';
import { SKILL_ROOT } from './artifacts.mjs';

export const VENV_DIR = join(SKILL_ROOT, '.venv');
// headless opencv: no libGL/X11 system deps — required for clean VPS installs
export const PY_DEPS = ['faster-whisper>=1.1,<2', 'opencv-python-headless>=4.10,<5'];

const IS_WINDOWS = process.platform === 'win32';

// Candidate interpreters per OS; `args` precede every python argument (the
// Windows `py` launcher needs `-3`). Windows Store stubs that just open the
// Store fail the version probe and are skipped naturally.
const PYTHON_CANDIDATES = IS_WINDOWS
  ? [{ bin: 'py', args: ['-3'] }, { bin: 'python', args: [] }, { bin: 'python3', args: [] }]
  : [{ bin: 'python3', args: [] }, { bin: 'python', args: [] }];

export async function findSystemPython() {
  for (const { bin, args } of PYTHON_CANDIDATES) {
    const res = await tryRun(bin, [...args, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])']);
    if (!res.failed) {
      const [maj, min] = res.stdout.trim().split('.').map(Number);
      if (maj > 3 || (maj === 3 && min >= 9)) return { bin, args, version: res.stdout.trim() };
      return { bin, args, version: res.stdout.trim(), tooOld: true };
    }
  }
  return null;
}

export function venvPython() {
  return IS_WINDOWS ? join(VENV_DIR, 'Scripts', 'python.exe') : join(VENV_DIR, 'bin', 'python');
}

export function venvReady() {
  return existsSync(venvPython());
}

export async function createVenv(onProgress = () => {}) {
  const sys = await findSystemPython();
  const installHint = IS_WINDOWS
    ? 'install Python 3 from https://python.org (check "Add to PATH") or `winget install Python.Python.3.12`'
    : 'apt install python3 python3-venv (or distro equivalent)';
  if (!sys) throw new Error(`python3 not found. fix: ${installHint}`);
  if (sys.tooOld) throw new Error(`python ${sys.version} is too old (need >= 3.9). fix: ${installHint}`);
  if (!venvReady()) {
    onProgress(`creating venv at ${VENV_DIR} (python ${sys.version})`);
    await run(sys.bin, [...sys.args, '-m', 'venv', VENV_DIR]);
  }
  onProgress('installing python deps (faster-whisper, opencv-python-headless) — first run only, may take a few minutes');
  await run(venvPython(), ['-m', 'pip', 'install', '--upgrade', 'pip', '--quiet']);
  await run(venvPython(), ['-m', 'pip', 'install', '--quiet', ...PY_DEPS]);
}

// Run a python script inside the venv; throws with the script's stderr on failure.
export async function runPython(scriptPath, args = [], opts = {}) {
  if (!venvReady()) throw new Error('python venv missing — run `node scripts/bootstrap.mjs` first');
  return run(venvPython(), [scriptPath, ...args], opts);
}

export async function pythonImportOk(module) {
  if (!venvReady()) return false;
  const res = await tryRun(venvPython(), ['-c', `import ${module}`]);
  return !res.failed;
}

export async function capturePython(code) {
  return capture(venvPython(), ['-c', code]);
}
