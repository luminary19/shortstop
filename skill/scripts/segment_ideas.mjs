#!/usr/bin/env node
// Shorts-mode idea segmentation guardrail. Claude drafts the idea list (judgment);
// this script validates it deterministically and prepares one clip workspace per
// idea so each can run its own EDL → captions → render → QA pass.
//
// Usage: node segment_ideas.mjs <runDir> <draftPath>
//   reads  <runDir>/{probe,transcript}.json
//   writes <runDir>/ideas.json + <runDir>/clip<N>/ (shared artifacts copied in)
//   exit 3 + JSON {ok:false, reasons:[...]} on stdout on rejection
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { readArtifact, writeArtifact, validateArtifact, loadConfig, ArtifactError } from './lib/artifacts.mjs';

const EPS = 1e-3;
const MIN_IDEA_RAW_S = 5;

export function validateIdeas(draft, { probe, config }) {
  const reasons = [];
  try {
    validateArtifact('ideas', draft);
  } catch (err) {
    if (err instanceof ArtifactError) {
      return { ok: false, reasons: err.errors.map((e) => ({ code: 'schema', detail: `${e.instancePath || '/'} ${e.message}` })) };
    }
    throw err;
  }

  const duration = probe.duration_s;
  // raw span ceiling: cutting trims fillers/pauses, it does not compress speech —
  // a raw span over 2× the clip cap cannot plausibly cut down to fit.
  const maxRawS = config.cut.max_clip_s != null ? 2 * config.cut.max_clip_s : null;
  draft.ideas.forEach((idea, i) => {
    const span = idea.end - idea.start;
    if (idea.start < -EPS || idea.end > duration + EPS) {
      reasons.push({ code: 'out_of_range', detail: `ideas[${i}] [${idea.start},${idea.end}] outside [0,${duration.toFixed(3)}]` });
    }
    if (span < MIN_IDEA_RAW_S) {
      reasons.push({ code: 'too_short', detail: `ideas[${i}] "${idea.title}" raw span ${span.toFixed(1)}s < ${MIN_IDEA_RAW_S}s — too thin for a self-contained clip; merge it into a neighbor or drop it` });
    }
    if (maxRawS != null && span > maxRawS + EPS) {
      reasons.push({ code: 'too_long', detail: `ideas[${i}] "${idea.title}" raw span ${span.toFixed(1)}s > ${maxRawS}s (2 × cut.max_clip_s) — split it or narrow it to the core of the idea` });
    }
  });
  if (reasons.length) return { ok: false, reasons };
  return { ok: true, ideas: draft };
}

// Per-idea clip workspaces: each gets copies of the shared full-source artifacts
// so every downstream stage runs unchanged with clipDir as its runDir.
export function prepareClipDirs(runDir, ideas) {
  const shared = ['probe.json', 'transcript.json', 'silence.json', 'track.json', 'config.overrides.json', 'ideas.json'];
  const dirs = [];
  for (const idea of ideas.ideas) {
    const clipDir = join(runDir, `clip${idea.id}`);
    mkdirSync(clipDir, { recursive: true });
    for (const f of shared) {
      const src = join(runDir, f);
      if (existsSync(src)) copyFileSync(src, join(clipDir, f));
    }
    dirs.push(clipDir);
  }
  return dirs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [runDir, draftPath] = process.argv.slice(2);
  if (!runDir || !draftPath) {
    console.error('usage: segment_ideas.mjs <runDir> <draftPath>');
    process.exit(1);
  }
  const { config } = loadConfig(process.cwd(), { runDir });
  const probe = readArtifact('probe', join(runDir, 'probe.json'));
  let draft;
  try {
    draft = JSON.parse(readFileSync(draftPath, 'utf8'));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, reasons: [{ code: 'parse', detail: err.message }] }));
    process.exit(3);
  }
  const result = validateIdeas(draft, { probe, config });
  if (!result.ok) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(3);
  }
  writeArtifact('ideas', join(runDir, 'ideas.json'), result.ideas);
  const dirs = prepareClipDirs(runDir, result.ideas);
  console.log(`ideas ok: ${result.ideas.ideas.length} idea(s) — ` +
    result.ideas.ideas.map((i) => `#${i.id} "${i.title}" [${i.start.toFixed(1)}–${i.end.toFixed(1)}s, strength ${i.strength}]`).join(', ') +
    `\nclip dirs: ${dirs.join(', ')}`);
}
