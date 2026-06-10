#!/usr/bin/env node
// Stage 4 guardrail — the ONLY snapping authority (§5.5).
// Validates Claude's draft EDL, pads boundaries outward, snaps them into
// detected silence, merges, runs the no-straddle check, emits coverage stats.
// Rejections are machine-readable so Claude can repair and resubmit.
//
// Usage: node build_edl.mjs <runDir> <draftPath>
//   reads  <runDir>/{probe,silence,transcript}.json
//   writes <runDir>/edl.json on success
//   exit 3 + JSON {ok:false, reasons:[...]} on stdout on rejection
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { readArtifact, writeArtifact, validateArtifact, loadConfig, ArtifactError } from './lib/artifacts.mjs';
import { snapToFrame, framesToSeconds } from './lib/timecode.mjs';

const EPS = 1e-3;

function inSilence(t, regions) {
  return regions.some((r) => t >= r.start - EPS && t <= r.end + EPS);
}

// Snapping rule (refined from the plan's literal "midpoint always"):
// snapping only ever EXPANDS a keep into its removed gap — that is what absorbs
// Whisper word-end slop without ever resurrecting removed content.
//  - a boundary already inside detected silence stays put;
//  - an END boundary moves RIGHT to min(midpoint, silence_start + NUDGE) of the
//    first silence region in its gap;
//  - a START boundary moves LEFT to max(midpoint, silence_end - NUDGE);
//  - movement is capped at SNAP_MAX (a midpoint 1.6 s away is not slop absorption
//    — naive midpoint snapping collapses long-pause removals to zero).
const SNAP_NUDGE = 0.25;
const SNAP_MAX = 1.0;

function snapEndBoundary(t, gapHi, regions) {
  if (inSilence(t, regions)) return t;
  const region = regions.find((r) => r.end > t + EPS && r.start < gapHi - EPS);
  if (!region) return t;
  const target = Math.min((region.start + region.end) / 2, Math.max(t, region.start) + SNAP_NUDGE, gapHi);
  return (target - t) > 0 && (target - t) <= SNAP_MAX ? target : t;
}

function snapStartBoundary(t, gapLo, regions) {
  if (inSilence(t, regions)) return t;
  const region = [...regions].reverse().find((r) => r.start < t - EPS && r.end > gapLo + EPS);
  if (!region) return t;
  const target = Math.max((region.start + region.end) / 2, Math.min(t, region.end) - SNAP_NUDGE, gapLo);
  return (t - target) > 0 && (t - target) <= SNAP_MAX ? target : t;
}

export function buildEdl(draft, { probe, silence, transcript, config }) {
  const reasons = [];
  const duration = probe.duration_s;
  const { fps_num: num, fps_den: den } = probe;
  const padS = config.cut.pad_s;
  const twoFrames = 2 * framesToSeconds(1, num, den);

  // 1. schema validation
  try {
    validateArtifact('edl', draft);
  } catch (err) {
    if (err instanceof ArtifactError) {
      return { ok: false, reasons: err.errors.map((e) => ({ code: 'schema', detail: `${e.instancePath || '/'} ${e.message}` })) };
    }
    throw err;
  }

  // range check (sorted/non-overlap already enforced by validateArtifact)
  draft.keep.forEach((k, i) => {
    if (k.start < -EPS || k.end > duration + EPS) {
      reasons.push({ code: 'out_of_range', detail: `keep[${i}] [${k.start},${k.end}] outside [0,${duration.toFixed(3)}]` });
    }
  });
  if (reasons.length) return { ok: false, reasons };

  // 2. pad outward, clamp
  let keeps = draft.keep.map((k) => ({
    start: Math.max(0, k.start - padS),
    end: Math.min(duration, k.end + padS),
    reason: k.reason,
  }));

  // 3. snap into silence (interior boundaries only; clip edges stay at 0/duration if padded there)
  const regions = silence.regions;
  for (let i = 0; i < keeps.length; i++) {
    const gapLoPrev = i === 0 ? 0 : keeps[i - 1].end;
    const gapHiNext = i === keeps.length - 1 ? duration : keeps[i + 1].start;
    if (keeps[i].start > EPS) {
      keeps[i].start = snapStartBoundary(keeps[i].start, gapLoPrev, regions);
    }
    if (keeps[i].end < duration - EPS) {
      keeps[i].end = snapEndBoundary(keeps[i].end, gapHiNext, regions);
    }
  }

  // frame-grid snap so Σkeep is frame-exact for the renderer
  keeps = keeps.map((k) => ({ ...k, start: Math.max(0, snapToFrame(k.start, num, den)), end: Math.min(duration, snapToFrame(k.end, num, den)) }));

  // 4. merge keeps that touch/overlap or whose gap is shorter than 2 frames
  const merged = [];
  for (const k of keeps) {
    const last = merged[merged.length - 1];
    if (last && k.start - last.end < twoFrames) {
      last.end = Math.max(last.end, k.end);
      if (k.reason && !last.reason.includes(k.reason)) last.reason += `; ${k.reason}`;
    } else {
      merged.push({ ...k });
    }
  }
  keeps = merged.filter((k) => k.end - k.start > EPS);
  if (!keeps.length) {
    return { ok: false, reasons: [{ code: 'empty', detail: 'no keep segments survive padding/merging' }] };
  }

  // 5. no-straddle check: every word fully inside a keep or fully inside a gap
  const words = transcript.segments.flatMap((s) => s.words);
  for (const w of words) {
    const insideKeep = keeps.some((k) => w.start >= k.start - EPS && w.end <= k.end + EPS);
    const insideGap = !keeps.some((k) => w.end > k.start + EPS && w.start < k.end - EPS);
    if (!insideKeep && !insideGap) {
      reasons.push({
        code: 'straddle',
        detail: `word "${w.word}" [${w.start.toFixed(2)},${w.end.toFixed(2)}] straddles a keep boundary — move the cut into the adjacent silence or keep the whole word`,
      });
    }
  }
  if (reasons.length) return { ok: false, reasons };

  // removed[] = complement of keeps, kinds attributed from the draft's removals
  const removed = [];
  const gaps = [];
  if (keeps[0].start > EPS) gaps.push({ start: 0, end: keeps[0].start });
  for (let i = 1; i < keeps.length; i++) gaps.push({ start: keeps[i - 1].end, end: keeps[i].start });
  if (duration - keeps[keeps.length - 1].end > EPS) gaps.push({ start: keeps[keeps.length - 1].end, end: duration });
  for (const g of gaps) {
    const overlapping = draft.removed
      .map((r) => ({ r, ov: Math.min(g.end, r.end) - Math.max(g.start, r.start) }))
      .filter((x) => x.ov > 0)
      .sort((a, b) => b.ov - a.ov);
    removed.push({
      start: g.start,
      end: g.end,
      kind: overlapping[0]?.r.kind ?? 'silence',
      reason: overlapping[0]?.r.reason ?? 'unspoken gap',
    });
  }

  // 6. coverage stats
  const keptS = keeps.reduce((a, k) => a + (k.end - k.start), 0);
  const removedByKind = {};
  for (const r of removed) removedByKind[r.kind] = (removedByKind[r.kind] ?? 0) + (r.end - r.start);
  const edl = {
    source: draft.source,
    keep: keeps,
    removed,
    notes: draft.notes ?? '',
    stats: {
      kept_s: keptS,
      removed_s: duration - keptS,
      kept_pct: (keptS / duration) * 100,
      removed_by_kind: removedByKind,
    },
  };
  validateArtifact('edl', edl);
  return { ok: true, edl };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [runDir, draftPath] = process.argv.slice(2);
  if (!runDir || !draftPath) {
    console.error('usage: build_edl.mjs <runDir> <draftPath>');
    process.exit(1);
  }
  const { config } = loadConfig();
  const probe = readArtifact('probe', join(runDir, 'probe.json'));
  const silence = readArtifact('silence', join(runDir, 'silence.json'));
  const transcript = readArtifact('transcript', join(runDir, 'transcript.json'));
  let draft;
  try {
    draft = JSON.parse(readFileSync(draftPath, 'utf8'));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, reasons: [{ code: 'parse', detail: err.message }] }));
    process.exit(3);
  }
  const result = buildEdl(draft, { probe, silence, transcript, config });
  if (!result.ok) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(3);
  }
  writeArtifact('edl', join(runDir, 'edl.json'), result.edl);
  const s = result.edl.stats;
  console.log(`edl ok: ${result.edl.keep.length} keeps, kept ${s.kept_s.toFixed(2)}s (${s.kept_pct.toFixed(0)}%), removed ${s.removed_s.toFixed(2)}s`);
}
