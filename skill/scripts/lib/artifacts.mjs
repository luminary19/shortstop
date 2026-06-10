// Schema-validated read/write for every pipeline artifact.
// Every stage goes through this module; nothing reads or writes runs/<id>/*.json directly.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA_DIR = join(SKILL_ROOT, 'schemas');

export const ARTIFACT_KINDS = ['probe', 'transcript', 'silence', 'track', 'edl', 'qa_report'];

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

// Defaults merged under <projectDir>/shortstop.config.json (if present); result is validated.
export function loadConfig(projectDir = process.cwd()) {
  const defaults = JSON.parse(readFileSync(join(SKILL_ROOT, 'config', 'default.config.json'), 'utf8'));
  let merged = defaults;
  const overridePath = join(projectDir, 'shortstop.config.json');
  let overridden = false;
  try {
    const override = JSON.parse(readFileSync(overridePath, 'utf8'));
    merged = deepMerge(defaults, override);
    overridden = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`cannot read ${overridePath}: ${err.message}`);
  }
  validateArtifact('config', merged);
  return { config: merged, overridden };
}

export { SKILL_ROOT };
