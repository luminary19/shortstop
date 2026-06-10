// Array-spawn wrapper around execa. No shell strings anywhere in the pipeline;
// filenames with spaces/unicode are always safe.
import { execa } from 'execa';

export class SpawnError extends Error {
  constructor(bin, args, result) {
    const detail = (result.stderr || result.stdout || result.shortMessage || '').trim();
    super(`${bin} failed (exit ${result.exitCode ?? 'signal ' + result.signal}):\n${detail.slice(-2000)}`);
    this.name = 'SpawnError';
    this.bin = bin;
    this.args = args;
    this.exitCode = result.exitCode;
    this.signal = result.signal;
    this.stderr = result.stderr;
  }
}

// Run a process; throws SpawnError on non-zero exit. Returns { stdout, stderr }.
export async function run(bin, args, opts = {}) {
  const result = await execa(bin, args, { reject: false, ...opts });
  if (result.failed) throw new SpawnError(bin, args, result);
  return result;
}

// Run and return trimmed stdout.
export async function capture(bin, args, opts = {}) {
  const { stdout } = await run(bin, args, opts);
  return stdout.trim();
}

// Run without throwing; caller inspects the result.
export async function tryRun(bin, args, opts = {}) {
  return execa(bin, args, { reject: false, ...opts });
}
