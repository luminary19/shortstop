# QA gap fix (prompt template Claude applies to itself)

A rendered candidate failed deterministic QA. Your job: choose the **minimal** change
that closes the **single highest-priority gap** — hard gaps first, then largest
deviation. One targeted change per attempt; never a rewrite.

## Before judging: deterministic remediations

These gaps have known mechanical fixes — apply them directly, no judgment needed:

| gap | remediation | re-render |
|---|---|---|
| `loudness` | re-run render pass B (it re-measures and recomputes loudnorm) | pass B only |
| `clipping` | re-run pass B with `audioOverrides.true_peak_db` 0.5 dB lower | pass B only |
| `captions` | re-run `build_captions.mjs` against the current `edl.json`, then pass B | pass B only |

## Judgment fixes (apply this template)

Read the failing `qa_report_a<N>.json` and the artifacts it implicates.

- `black_frames` / `frozen_frames` (hard): locate the defect time, map it back through
  the EDL to source time, and adjust the nearest keep boundary (typically the cut sits
  on a corrupted/black source region — move the boundary past it). Minimal EDL change
  targeting only that boundary; re-validate via `build_edl.mjs`; full re-render.
- `duration` (hard): the EDL and render disagree — do not tweak numbers blindly; re-run
  pass A (delete `mezzanine.mkv` or change the EDL) and re-measure.
- `framing` (soft): the subject drifts off-center. Re-cut is wrong; instead re-run
  `track.py`, then pass B. If it persists, accept as a reported soft gap.
- `shorts_length` (soft): only act if the user asked for a target duration — set
  `cut.target_duration_s`, re-run cut decisions (Stage 4), full re-render. Otherwise
  leave it; it is delivered with a report note.
- `pacing_advisory` (soft): **advisory only — never fix-driving on its own.** Do not
  change the EDL to chase the reference's cut density.

## Rules

- Fix exactly one gap per attempt (`gaps` ordered hard-first, largest deviation first).
- Every fix must be re-rendered and re-measured before the next decision
  (measure-first ordering — no fix is produced and then discarded).
- Re-render pass B only when the EDL is unchanged; EDL changes invalidate both passes.
- Respect the ceiling: `qa.max_fix_attempts` (default 5) fix attempts total, and stop
  early after 2 consecutive attempts with no score improvement.
- Hard gaps never ship. If the minimal change cannot clear a hard gap within budget,
  stop and let `deliver.mjs` write the refuse-report.
