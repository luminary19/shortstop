// Schema-validated read/write for every pipeline artifact.
// Every stage goes through this module; nothing reads or writes runs/<id>/*.json directly.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA_DIR = join(SKILL_ROOT, 'schemas');

export const ARTIFACT_KINDS = ['probe', 'transcript', 'silence', 'track', 'edl', 'qa_report', 'ideas'];

const ajv = new Ajv({ allErrors: true, strict: true });
const validators = new Map();

function validatorFor(kind) {
  if (!validators.has(kind)) {
    const schemaPath = kind === 'config'
      ? join(SKILL_ROOT, 'config', 'config.schema.json')
      : join(SCHEMA_DIR, `${kind}.schema.json`);
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    validators.set(kind, ajv.compile(schema));
  }
  return validators.get(kind);
}

export class ArtifactError extends Error {
  constructor(kind, errors) {
    super(`invalid ${kind} artifact:\n` + errors.map((e) => `  ${e.instancePath || '/'} ${e.message}`).join('\n'));
    this.name = 'ArtifactError';
    this.kind = kind;
    this.errors = errors;
  }
}

// Structural invariants the JSON Schema language can't express.
const SEMANTIC_CHECKS = {
  silence(data) {
    const errs = [];
    let prevEnd = -Infinity;
    data.regions.forEach((r, i) => {
      if (r.end <= r.start) errs.push({ instancePath: `/regions/${i}`, message: 'end must be > start' });
      if (r.start < prevEnd) errs.push({ instancePath: `/regions/${i}`, message: 'regions must be sorted and non-overlapping' });
      prevEnd = r.end;
    });
    return errs;
  },
  edl(data) {
    const errs = [];
    let prevEnd = -Infinity;
    data.keep.forEach((k, i) => {
      if (k.end <= k.start) errs.push({ instancePath: `/keep/${i}`, message: 'end must be > start' });
      if (k.start < prevEnd) errs.push({ instancePath: `/keep/${i}`, message: 'keep segments must be sorted and non-overlapping' });
      prevEnd = k.end;
    });
    return errs;
  },
  ideas(data) {
    const errs = [];
    let prevEnd = -Infinity;
    const seen = new Set();
    data.ideas.forEach((idea, i) => {
      if (idea.end <= idea.start) errs.push({ instancePath: `/ideas/${i}`, message: 'end must be > start' });
      if (idea.start < prevEnd) errs.push({ instancePath: `/ideas/${i}`, message: 'ideas must be sorted and non-overlapping' });
      if (seen.has(idea.id)) errs.push({ instancePath: `/ideas/${i}`, message: `duplicate idea id ${idea.id}` });
      seen.add(idea.id);
      prevEnd = idea.end;
    });
    return errs;
  },
  transcript(data) {
    const errs = [];
    data.segments.forEach((s, i) => {
      s.words.forEach((w, j) => {
        if (w.end < w.start) errs.push({ instancePath: `/segments/${i}/words/${j}`, message: 'word end must be >= start' });
      });
    });
    return errs;
  },
};

export function validateArtifact(kind, data) {
  if (kind !== 'config' && !ARTIFACT_KINDS.includes(kind)) {
    throw new Error(`unknown artifact kind: ${kind}`);
  }
  const validate = validatorFor(kind);
  if (!validate(data)) throw new ArtifactError(kind, validate.errors);
  const semanticErrs = SEMANTIC_CHECKS[kind] ? SEMANTIC_CHECKS[kind](data) : [];
  if (semanticErrs.length) throw new ArtifactError(kind, semanticErrs);
  return data;
}

export function readArtifact(kind, path) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${kind} artifact at ${path}: ${err.message}`);
  }
  return validateArtifact(kind, data);
}

export function writeArtifact(kind, path, data) {
  validateArtifact(kind, data);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  return data;
}

function deepMerge(base, override) {
  if (override === undefined) return base;
  if (base === null || override === null) return override;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (typeof base === 'object' && typeof override === 'object') {
    const out = { ...base };
    for (const key of Object.keys(override)) out[key] = deepMerge(base[key], override[key]);
    return out;
  }
  return override;
}

// Mode presets sit between defaults and user overrides: a project/run override of
// any individual key still wins over its mode's preset value.
export const MODE_PRESETS = {
  shorts: {
    aspect: { mode: '9:16', out_width: 720, out_height: 1280 },
    cut: { max_clip_s: 60 },
    qa: { shorts_max_s: 60 },
  },
  longform: {
    aspect: { mode: '16:9', out_width: 1920, out_height: 1080 },
    cut: { max_clip_s: null },
    qa: { shorts_max_s: null },
  },
};

function readJsonIfPresent(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`cannot read ${label} at ${path}: ${err.message}`);
  }
}

// Merge order: defaults < MODE_PRESETS[mode] < <projectDir>/shortstop.config.json
// < <runDir>/config.overrides.json (the per-run mode/aspect choice written by the
// orchestrator). The mode itself is taken from the most specific layer that sets it.
export function loadConfig(projectDir = process.cwd(), { runDir } = {}) {
  const defaults = JSON.parse(readFileSync(join(SKILL_ROOT, 'config', 'default.config.json'), 'utf8'));
  const project = readJsonIfPresent(join(projectDir, 'shortstop.config.json'), 'project config');
  const run = runDir ? readJsonIfPresent(join(runDir, 'config.overrides.json'), 'run config overrides') : null;

  const mode = run?.mode ?? project?.mode ?? defaults.mode ?? 'shorts';
  if (!MODE_PRESETS[mode]) throw new Error(`unknown mode "${mode}" (expected shorts | longform)`);

  let merged = deepMerge(deepMerge(defaults, { mode }), MODE_PRESETS[mode]);
  if (project) merged = deepMerge(merged, project);
  if (run) merged = deepMerge(merged, run);
  validateArtifact('config', merged);
  return { config: merged, overridden: Boolean(project || run) };
}

export { SKILL_ROOT };
